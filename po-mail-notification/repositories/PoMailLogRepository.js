'use strict';
const cds = require('@sap/cds');
const Constants = require('../constants/PoConstants');

let lastRunWatermark = null;
const memorySent = new Set();
let persistentAvailable = null;

function memoryKey(poNumber, companyCode) {
  return `${String(companyCode || '').trim()}|${String(poNumber || '').trim()}`;
}

class PoMailLogRepository {
  constructor({ entity = Constants.LOG_ENTITY } = {}) {
    this.entity = entity;
  }

  async _db() {
    const db = cds.db || cds.services?.db;
    if (!db) throw new Error('no db service bound');
    return db;
  }
  get isPersistent() {
    return persistentAvailable === true;
  }

  /**
   * PO numbers that already have a SENT mail.
   * @param {Array<{poNumber:string,companyCode:string}>} candidates
   * @returns {Promise<Set<string>>} set of "companyCode|poNumber" keys
   */
  async filterAlreadySent(candidates = []) {
    const list = candidates.filter((entry) => entry?.poNumber);
    if (!list.length) return new Set();

    if (persistentAvailable === false) {
      return new Set(list.filter((entry) => memorySent.has(memoryKey(entry.poNumber, entry.companyCode)))
        .map((entry) => memoryKey(entry.poNumber, entry.companyCode)));
    }

    try {
      const db = await this._db();
      const numbers = [...new Set(list.map((entry) => String(entry.poNumber)))];
      const rows = await db.run(
        SELECT.from(this.entity)
          .columns('PO_NUMBER', 'COMPANY_CODE', 'MAIL_STATUS')
          .where({ PO_NUMBER: { in: numbers } })
      );
      persistentAvailable = true;
      return new Set(
        (rows || [])
          .filter((row) => String(row.MAIL_STATUS || '').toUpperCase() === 'SENT')
          .map((row) => memoryKey(row.PO_NUMBER, row.COMPANY_CODE))
      );
    } catch (error) {
      persistentAvailable = false;
      console.warn(
        `[PoMailLogRepository] Log entity '${this.entity}' is not available (${error.message}). ` +
        'Falling back to watermark + in-memory de-duplication for this instance. ' +
        'To make it restart-safe, add the entity from po-mail-notification/db/po-mail-log-entity.cds.txt to db/schema.cds.'
      );
      return new Set(
        list.filter((entry) => memorySent.has(memoryKey(entry.poNumber, entry.companyCode)))
          .map((entry) => memoryKey(entry.poNumber, entry.companyCode))
      );
    }
  }

  /**
   * Record the outcome of one PO mail.
   * @returns {Promise<boolean>} true when persisted in HANA
   */
  async record(entry = {}) {
    const key = memoryKey(entry.poNumber, entry.companyCode);
    if (entry.status === 'SENT') memorySent.add(key);

    if (persistentAvailable === false) return false;

    try {
      const db = await this._db();
      const { UPSERT } = cds.ql;
      await db.run(UPSERT.into(this.entity).entries({
        PO_NUMBER: String(entry.poNumber || '').slice(0, 20),
        COMPANY_CODE: String(entry.companyCode || '').slice(0, 4),
        DOCUMENT_TYPE: String(entry.documentType || '').slice(0, 10),
        MAIL_STATUS: String(entry.status || 'FAILED').slice(0, 20),
        RECIPIENTS: String(entry.recipients || '').slice(0, 1000),
        RULE_ID: String(entry.ruleId || '').slice(0, 20),
        APPROVAL_LEVEL: Number(entry.approvalLevel || Constants.TRIGGER_APPROVAL_LEVEL),
        MESSAGE_ID: String(entry.messageId || '').slice(0, 200),
        ERROR_MESSAGE: String(entry.errorMessage || '').slice(0, 500),
        RUN_ID: String(entry.runId || '').slice(0, 36),
        CREATED_BY: String(entry.actor || Constants.SYSTEM_USER).slice(0, 100),
        CREATED_TIMESTAMP: new Date().toISOString()
      }));
      persistentAvailable = true;
      return true;
    } catch (error) {
      persistentAvailable = false;
      console.warn(`[PoMailLogRepository] Could not persist mail log entry: ${error.message}`);
      return false;
    }
  }
  getLastRunWatermark() {
    return lastRunWatermark;
  }
  setLastRunWatermark(date) {
    if (date) lastRunWatermark = date;
  }
  describe() {
    return {
      entity: this.entity,
      mode: persistentAvailable === true ? 'PERSISTED' : (persistentAvailable === false ? 'IN_MEMORY' : 'UNKNOWN'),
      inMemorySentCount: memorySent.size,
      lastRunWatermark: lastRunWatermark ? lastRunWatermark.toISOString() : null
    };
  }
}

module.exports = PoMailLogRepository;