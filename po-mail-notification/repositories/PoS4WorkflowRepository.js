'use strict';

/**
 * Persistent checkpoint for S/4HANA workflow progress polling.
 *
 * This repository deliberately has no in-memory fallback: losing the last
 * completed-task count on restart could cause duplicate next-level emails.
 * Add the entity from db/po-s4-workflow-entity.cds.txt to the application's
 * db/schema.cds before enabling this workflow notification feature.
 */

const cds = require('@sap/cds');
const Constants = require('../constants/PoConstants');

class PoS4WorkflowRepository {
  constructor({ entity = Constants.S4_WORKFLOW_ENTITY } = {}) {
    this.entity = entity;
  }

  async _db() {
    // Re-acquire the DB service on every call. The cached `cds.db` reference
    // can become stale after a long scheduler tick (e.g. the 79-page S/4 scan),
    // causing UPDATEs to silently fail against a disconnected connection.
    const db = cds.db || cds.services?.db;
    if (!db) throw new Error('No CAP database service is bound.');

    const entity = cds.model?.definitions?.[this.entity];
    if (!entity) {
      throw new Error(
        `Entity ${this.entity} is not in the CAP model. Add ` +
        'db/po-s4-workflow-entity.cds.txt to db/schema.cds and deploy the DB module.'
      );
    }
    return db;
  }

  /**
   * Run a write operation with retry + return-value verification.
   *
   * The old code called `db.run(UPDATE...)` without checking the result,
   * so a dead DB connection caused silent failures (the log said "notified"
   * but the checkpoint never advanced → duplicate mails on the next poll).
   *
   * This helper retries the write and throws if 0 rows were affected, so
   * the caller can release the claim / log the failure.
   *
   * @param {Function} writeFn  async function returning the affected-row count
   * @param {number}   [retries=3]  number of attempts
   * @param {number}   [delayMs=500] delay between retries
   * @returns {Promise<number>} the affected-row count from the last attempt
   */
  async _runWithRetry(writeFn, retries = 3, delayMs = 500) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const result = await writeFn();
        // For UPDATE/DELETE, a result of 0 means the row was not found or
        // the connection silently failed. Treat it as an error so the
        // caller can handle it (release claim, log, etc.).
        if (result !== 1) {
          throw new Error(`Write affected ${result} rows (expected 1).`);
        }
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        }
      }
    }
    throw lastError;
  }

  async listActive() {
    const db = await this._db();
    const { SELECT } = cds.ql;
    return db.run(
      SELECT.from(this.entity).where({ TRACKING_STATUS: 'ACTIVE' })
    );
  }

  async get(poNumber, companyCode) {
    const db = await this._db();
    const { SELECT } = cds.ql;
    return db.run(SELECT.one.from(this.entity).where({
      PO_NUMBER: poNumber,
      COMPANY_CODE: companyCode
    }));
  }

  /**
   * Batch checkpoint lookup. Replaces the per-PO get() loop that was
   * issuing one DB round-trip per PO on every scan page — with ~2K POs/day
   * that meant thousands of queries per tick, exhausting the DB connection
   * pool ("Database connection is disconnected") and contributing to the OOM
   * crash (exit 137). One IN query returns every checkpoint for the batch.
   *
   * @param {Array<{poNumber: string, companyCode: string}>} candidates
   * @returns {Promise<Set<string>>} keys in the form "companyCode|poNumber"
   *   that already have a checkpoint row. Empty Set on any DB error (the
   *   caller treats that as "not tracked" and degrades duplicate protection).
   */
  async getMany(candidates = []) {
    const list = (candidates || []).filter((entry) => entry?.poNumber);
    if (!list.length) return new Set();

    const numbers = [...new Set(list.map((entry) => String(entry.poNumber)))];
    try {
      const db = await this._db();
      const { SELECT } = cds.ql;
      const rows = await db.run(
        SELECT.from(this.entity).where({ PO_NUMBER: { in: numbers } })
      );
      return new Set(
        (rows || []).map((row) => `${String(row.COMPANY_CODE)}|${String(row.PO_NUMBER)}`)
      );
    } catch (error) {
      console.warn(
        `[PoS4WorkflowRepository] getMany failed for ${numbers.length} PO(s): ${error.message}. ` +
        'Falling back to mail-log-only duplicate protection for this batch.'
      );
      return new Set();
    }
  }

  /** Create a starting checkpoint once; never reset an existing PO's progress. */
  async initialize({ poNumber, companyCode, documentType, ruleId, completedTasks, maxLevel }) {
    const existing = await this.get(poNumber, companyCode);
    if (existing) return existing;

    const db = await this._db();
    const { INSERT } = cds.ql;
    // One-level routes must also start ACTIVE: the poll observes the single
    // approver's final approval/rejection and sends the completion/rejection
    // notice; the row leaves the ACTIVE set when advance() marks it terminal.
    const status = maxLevel >= 1 ? 'ACTIVE' : 'COMPLETE';
    const row = {
      PO_NUMBER: String(poNumber).slice(0, 20),
      COMPANY_CODE: String(companyCode).slice(0, 4),
      DOCUMENT_TYPE: String(documentType || '').slice(0, 10),
      RULE_ID: String(ruleId || '').slice(0, 20),
      LAST_COMPLETED_TASKS: Number(completedTasks),
      MAX_LEVEL: Number(maxLevel),
      TRACKING_STATUS: status,
      UPDATED_AT: new Date().toISOString()
    };
    await db.run(INSERT.into(this.entity).entries(row));
    return row;
  }

  /** Save the observed S/4 task count after the matching notification succeeds. */
  async advance({ poNumber, companyCode, completedTasks, trackingStatus = 'ACTIVE' }) {
    const db = await this._db();
    const { UPDATE } = cds.ql;
    return this._runWithRetry(() => db.run(
      UPDATE(this.entity)
        .set({
          LAST_COMPLETED_TASKS: Number(completedTasks),
          TRACKING_STATUS: trackingStatus,
          UPDATED_AT: new Date().toISOString()
        })
        .where({ PO_NUMBER: poNumber, COMPANY_CODE: companyCode })
    ));
  }

  /* ── atomic claim (prevents duplicate sends) ──────────────────────── */

  /**
   * Atomically claim the right to send the NEXT notification for a PO.
   *
   * Sets TRACKING_STATUS to 'SENDING' (a transient marker) but does NOT
   * change LAST_COMPLETED_TASKS. Only succeeds if the checkpoint is currently
   * ACTIVE at exactly `expectedTasks`. This is a compare-and-set: only one
   * caller (one tick / one instance) can win the claim, so the same level
   * mail can never be sent twice.
   *
   * @returns {Promise<boolean>} true when this caller won the claim (send the
   *   mail), false when another caller already claimed/advanced it (skip).
   */
  async claim({ poNumber, companyCode, expectedTasks }) {
    const db = await this._db();
    const { UPDATE } = cds.ql;
    const result = await this._runWithRetry(() => db.run(
      UPDATE(this.entity)
        .set({
          TRACKING_STATUS: 'SENDING',
          UPDATED_AT: new Date().toISOString()
        })
        .where({
          PO_NUMBER: poNumber,
          COMPANY_CODE: companyCode,
          LAST_COMPLETED_TASKS: Number(expectedTasks),
          TRACKING_STATUS: 'ACTIVE'
        })
    ));
    return result === 1;
  }

  /**
   * Finalize a claim after a successful send: advance the checkpoint and
   * clear the SENDING marker back to the proper status.
   */
  async finalize({ poNumber, companyCode, targetTasks, trackingStatus }) {
    const db = await this._db();
    const { UPDATE } = cds.ql;
    return this._runWithRetry(() => db.run(
      UPDATE(this.entity)
        .set({
          LAST_COMPLETED_TASKS: Number(targetTasks),
          TRACKING_STATUS: trackingStatus,
          UPDATED_AT: new Date().toISOString()
        })
        .where({ PO_NUMBER: poNumber, COMPANY_CODE: companyCode })
    ));
  }

  /**
   * Release a claim after a FAILED send: revert back to ACTIVE at the same
   * task count so the next poll retries. No duplicate is possible because the
   * SENDING marker blocked other callers during the attempt.
   */
  async release({ poNumber, companyCode, expectedTasks }) {
    const db = await this._db();
    const { UPDATE } = cds.ql;
    return this._runWithRetry(() => db.run(
      UPDATE(this.entity)
        .set({
          TRACKING_STATUS: 'ACTIVE',
          UPDATED_AT: new Date().toISOString()
        })
        .where({
          PO_NUMBER: poNumber,
          COMPANY_CODE: companyCode,
          LAST_COMPLETED_TASKS: Number(expectedTasks),
          TRACKING_STATUS: 'SENDING'
        })
    ));
  }

  /**
   * Atomically create the checkpoint AND claim the initial (Level 1) mail.
   * Inserts a new row with TRACKING_STATUS='SENDING'. Returns true when this
   * caller created the row (won the claim); false when the row already exists
   * (another sender already claimed it — skip).
   *
   * Distinguishes a duplicate-key conflict (row exists → claim lost) from a
   * real DB error (rethrow).
   */
  async claimInitial({ poNumber, companyCode, documentType, ruleId, completedTasks, maxLevel }) {
    const db = await this._db();
    const { INSERT } = cds.ql;
    const row = {
      PO_NUMBER: String(poNumber).slice(0, 20),
      COMPANY_CODE: String(companyCode).slice(0, 4),
      DOCUMENT_TYPE: String(documentType || '').slice(0, 10),
      RULE_ID: String(ruleId || '').slice(0, 20),
      LAST_COMPLETED_TASKS: Number(completedTasks),
      MAX_LEVEL: Number(maxLevel),
      TRACKING_STATUS: 'SENDING',
      UPDATED_AT: new Date().toISOString()
    };
    try {
      await db.run(INSERT.into(this.entity).entries(row));
      return true;
    } catch (error) {
      // Duplicate key → checkpoint already exists → another sender claimed it.
      const existing = await this.get(poNumber, companyCode);
      if (existing) return false;
      throw error; // real DB error — let the caller handle it
    }
  }

  /**
   * Release an initial claim after a FAILED Level 1 send: delete the row so
   * the next scan retries the creation mail.
   */
  async releaseInitial({ poNumber, companyCode }) {
    const db = await this._db();
    const { DELETE } = cds.ql;
    await db.run(
      DELETE.from(this.entity).where({
        PO_NUMBER: poNumber,
        COMPANY_CODE: companyCode
      })
    );
  }

  /**
   * Recovery: find rows stuck in 'SENDING' (claim won but finalize never
   * completed — e.g. DB disconnected after the mail was sent).
   *
   * IMPORTANT: These rows are NOT auto-reset to ACTIVE. If the mail was
   * actually sent but finalize() failed (DB disconnected), resetting to
   * ACTIVE would cause a DUPLICATE send on the next poll. Leaving them in
   * SENDING blocks re-sends safely.
   *
   * The row is only reset if the caller explicitly confirms the mail was NOT
   * sent (via force/manual intervention). This method just reports what's stuck.
   *
   * @returns {Promise<Array>} list of stuck checkpoint rows
   */
  async findStaleSending() {
    const db = await this._db();
    const { SELECT } = cds.ql;
    return db.run(
      SELECT.from(this.entity).where({ TRACKING_STATUS: 'SENDING' })
    );
  }

  /**
   * Manually release a SENDING row back to ACTIVE after confirming the mail
   * was NOT actually sent. Use only for manual intervention.
   */
  async forceResetSending({ poNumber, companyCode }) {
    const db = await this._db();
    const { UPDATE } = cds.ql;
    return this._runWithRetry(() => db.run(
      UPDATE(this.entity)
        .set({
          TRACKING_STATUS: 'ACTIVE',
          UPDATED_AT: new Date().toISOString()
        })
        .where({
          PO_NUMBER: poNumber,
          COMPANY_CODE: companyCode,
          TRACKING_STATUS: 'SENDING'
        })
    ));
  }
}

module.exports = PoS4WorkflowRepository;