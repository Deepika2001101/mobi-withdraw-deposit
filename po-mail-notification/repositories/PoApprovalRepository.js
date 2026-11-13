'use strict';

const cds = require('@sap/cds');
const Constants = require('../constants/PoConstants');

class PoApprovalRepository {
  constructor() {
    this._memory = new Map();
    this._persistent = null;         
  }

  async _probe() {
    if (this._persistent !== null) return this._persistent;
    try {
      const entity = cds.model?.definitions?.[Constants.APPROVAL_ENTITY];
      if (entity && cds.db) {
        await cds.run(SELECT.one.from(Constants.APPROVAL_ENTITY).limit(1));
        this._persistent = true;
      } else {
        this._persistent = false;
      }
    } catch (error) {
      this._persistent = false;
    }
    if (!this._persistent) {
      console.warn(
        `[PoApprovalRepository] Entity ${Constants.APPROVAL_ENTITY} not available - ` +
        'decisions are kept in memory only (a restart forgets them and re-opens links). ' +
        'Append db/po-approval-entity.cds.txt to db/schema.cds for persisted decisions.'
      );
    }
    return this._persistent;
  }

  static _key(poNumber, companyCode, level) {
    return `${companyCode}|${poNumber}|${level}`;
  }

  /** @returns {null | {decision, decidedBy, decidedAt, nextLevel, nextMailedTo}} */
  async getDecision(poNumber, companyCode, level) {
    if (await this._probe()) {
      try {
        const row = await cds.run(
          SELECT.one.from(Constants.APPROVAL_ENTITY).where({
            PO_NUMBER: poNumber, COMPANY_CODE: companyCode, APPROVAL_LEVEL: level
          })
        );
        if (!row) return null;
        return {
          decision: row.DECISION,
          decidedBy: row.DECIDED_BY,
          decidedAt: row.DECIDED_AT,
          nextLevel: row.NEXT_LEVEL,
          nextMailedTo: row.NEXT_MAILED_TO,
          remarks: row.REMARKS || ''
        };
      } catch (error) {
        
        throw new Error(`Approval ledger read failed; refusing to continue: ${error.message}`);
      }
    }
    return this._memory.get(PoApprovalRepository._key(poNumber, companyCode, level)) || null;
  }
  async record({ poNumber, companyCode, level, decision, decidedBy, remarks = '', nextLevel = 0, nextMailedTo = '', messageId = '', runId = '', decidedAt = '' }) {
    const entry = {
      decision,
      decidedBy,
      decidedAt: decidedAt || new Date().toISOString(),
      nextLevel,
      nextMailedTo,
      remarks
    };
    if (await this._probe()) {
      try {
        await cds.run(
          UPSERT.into(Constants.APPROVAL_ENTITY).entries({
            PO_NUMBER: poNumber,
            COMPANY_CODE: companyCode,
            APPROVAL_LEVEL: level,
            DECISION: decision,
            DECIDED_BY: decidedBy,
            DECIDED_AT: entry.decidedAt,
            REMARKS: remarks,
            NEXT_LEVEL: nextLevel,
            NEXT_MAILED_TO: nextMailedTo,
            MESSAGE_ID: messageId,
            RUN_ID: runId
          })
        );
        return entry;
      } catch (error) {
        throw new Error(`Approval ledger write failed: ${error.message}`);
      }
    }
    this._memory.set(PoApprovalRepository._key(poNumber, companyCode, level), entry);
    return entry;
  }

  async info() {
    const persistent = await this._probe();
    return {
      mode: persistent ? 'PERSISTED' : 'IN_MEMORY',
      entity: Constants.APPROVAL_ENTITY,
      decisions: persistent ? null : this._memory.size
    };
  }
}

module.exports = PoApprovalRepository;