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
    // Reuse CAP's already-connected DB service. Opening another connection
    // here can return a disconnected service in hybrid runs or after a long
    // scheduler tick.
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
    await db.run(
      UPDATE(this.entity)
        .set({
          LAST_COMPLETED_TASKS: Number(completedTasks),
          TRACKING_STATUS: trackingStatus,
          UPDATED_AT: new Date().toISOString()
        })
        .where({ PO_NUMBER: poNumber, COMPANY_CODE: companyCode })
    );
  }
}

module.exports = PoS4WorkflowRepository;