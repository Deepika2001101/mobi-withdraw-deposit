'use strict';

/**
 * PO mail notification — orchestration.
 *
 * Flow (one run):
 *   1. Resolve the PO destination config (SMTP_MOBI_PO_DEV) once. It supplies
 *      BOTH the SMTP transport and the mail.po.approval.rule.* routing rules.
 *   2. Read the new purchase orders from S/4HANA over the S4HANA_MOBI
 *      destination (PO CDS view, header + items in one round trip).
 *   3. Normalise every header/item row into the exact field set the mail needs
 *      (PoFieldMapper) and derive missing money fields.
 *   4. Drop POs that were already mailed (PoMailLogRepository).
 *   5. Resolve recipients from the routing rule. Level 1 is notified on
 *      creation; later levels are notified after S/4HANA My Inbox increments
 *      the completed workflow-task count. AUTO_APPROVE documents are skipped.
 *   6. Build the HTML mail (PoMailTemplate) and send it (PoMailSender).
 *   7. Record the outcome. A mail failure never fails the run — it is reported
 *      in the result and, optionally, to the operations fallback address.
 */

const { v4: uuid } = require('uuid');

const Constants = require('../constants/PoConstants');
const Mapper = require('../utils/PoFieldMapper');
const { formatAmount, formatMoney, formatQuantity, formatPercent, amountInWords } = require('../utils/PoAmountUtil');
const { formatRunStamp, daysAgoStart } = require('../utils/PoDateUtil');
const { getMailEnvironment } = require('./PoSmtpDestination');
const { buildPoApprovalMail } = require('./PoMailTemplate');
const PoS4WorkflowRepository = require('../repositories/PoS4WorkflowRepository');

class PoMailService {
  /**
   * @param {object} deps
   * @param {object} deps.client      S4PoClient
   * @param {object} deps.sender      PoMailSender
   * @param {object} deps.repository  PoMailLogRepository
   * @param {function} deps.Routing   PoApprovalRouting class
   */
  constructor({ client, sender, repository, Routing }) {
    this.client = client;
    this.sender = sender;
    this.repository = repository;
    this.Routing = Routing;
    this.workflowProgress = new PoS4WorkflowRepository();
    this._s4WorkflowPollInFlight = false;
  }

  /* ── public ─────────────────────────────────────────────────────────── */

  /**
   * Send approval mails for newly created purchase orders.
   *
   * @param {object} [args]
   * @param {string} [args.purchaseOrder]  single PO number (skips the date range)
   * @param {Date}   [args.fromDate]       created-on lower bound (inclusive)
   * @param {Date}   [args.toDate]         created-on upper bound (exclusive)
   * @param {number} [args.lookbackDays]   used when fromDate is absent
   * @param {string} [args.companyCode]    optional filter
   * @param {string} [args.documentType]   optional filter
   * @param {boolean}[args.dryRun]         resolve + build, do not send, do not log
   * @param {boolean}[args.force]           ignore the already-mailed log
   * @param {string} [args.actor]
   */
  async run(args = {}) {
    const runId = uuid();
    const startedAt = new Date();
    const dryRun = args.dryRun === true;
    const actor = args.actor || Constants.SYSTEM_USER;

    const result = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      read: 0,
      new: 0,
      mailed: 0,
      dryRunPrepared: 0,
      skippedAlreadySent: 0,
      skippedNoApprover: 0,
      skippedAutoApprove: 0,
      failed: 0,
      degraded: false,
      dryRun,
      range: null,
      routing: null,
      purchaseOrders: [],
      message: ''
    };

    // 1. Destination: SMTP + routing rules in one read.
    const smtpConfig = await this.sender.config();
    const routing = this.Routing.fromConfig(smtpConfig);
    result.routing = {
      mailDestination: smtpConfig.source,
      schemaVersion: routing.schemaVersion,
      onAmbiguousMatch: routing.onAmbiguousMatch,
      rules: routing.rules.length,
      parseErrors: routing.parseErrors
    };

    // Poll existing S/4 workflow tasks on every scheduled/manual run. This is
    // notification-only; the actual approval remains in S/4HANA My Inbox.
    if (!dryRun) {
      await this._pollS4WorkflowProgress({ routing, smtpConfig });
    }

    // 2. Date range: explicit > overlapping watermark > lookback.
    //
    // YY1_PO_EMAIL exposes CreationDate as a date-only S/4 business date. Its
    // calendar may differ from the local email/display timezone around
    // midnight (for example, S/4 can still report yesterday while India is
    // already on tomorrow). Keep the scan's calendar configurable separately
    // from PO_MAIL_TIME_ZONE, which is used only for rendered email dates.
    const creationDateTimeZone = String(
      process.env.PO_MAIL_CREATION_DATE_TIME_ZONE || Constants.TIME_ZONE
    ).trim();
    const lastRun = this.repository.getLastRunWatermark();
    const overlapFromDate = lastRun
      ? new Date(lastRun.getTime() - (48 * 60 * 60 * 1000))
      : null;
    const todayOnly = Constants.MAIL_WINDOW_MODE === 'today';
    const fromDate = args.fromDate
      || (todayOnly ? daysAgoStart(1, creationDateTimeZone) : overlapFromDate)
      || daysAgoStart(args.lookbackDays ?? Constants.DEFAULT_LOOKBACK_DAYS, creationDateTimeZone);
    const toDate = args.toDate || null;
    console.log(
      `[PoMailService] PO scan window: mode=${Constants.MAIL_WINDOW_MODE}, ` +
      `field=${Constants.CREATED_ON_FIELD}, timezone=${creationDateTimeZone}, ` +
      `from=${fromDate.toISOString()}, to=${toDate ? toDate.toISOString() : 'open'}.`
    );
    result.range = args.purchaseOrder
      ? { purchaseOrder: args.purchaseOrder }
      : { from: fromDate.toISOString(), to: toDate ? toDate.toISOString() : null };

    // 3. Read from S/4HANA.
    const fetched = await this.client.getPurchaseOrders({
      fromDate,
      toDate,
      purchaseOrder: args.purchaseOrder || '',
      companyCode: args.companyCode || '',
      documentType: args.documentType || ''
    });
    result.degraded = Boolean(fetched.degraded);
    const windowTruncated = Boolean(fetched.truncated);
    result.truncated = windowTruncated;
    result.read = (fetched.rows || []).length;
    if (!result.read) {
      result.message = windowTruncated
        ? 'Read window truncated before any row was read — watermark held, retrying next tick.'
        : 'No purchase order found for the selected range.';
      result.finishedAt = new Date().toISOString();
      if (!windowTruncated) this.repository.setLastRunWatermark(startedAt);
      return result;
    }

    // 4. Normalise + group the flat rows into PO objects (header + items).
    const purchaseOrders = this._groupAndNormalize(fetched.rows);

    // 5. De-duplicate against the mail log and the existing S/4 workflow
    // checkpoint. The workflow table is also a persistent marker that the
    // initial notification was sent, so a restart does not re-mail a recent
    // multi-level PO when the optional mail-log entity is not deployed.
    let alreadySent = new Set();
    const workflowTracked = new Set();
    let workflowCheckUnavailable = false;
    if (!args.force) {
      alreadySent = await this.repository.filterAlreadySent(
        purchaseOrders.map((po) => ({ poNumber: po.poNumber, companyCode: po.companyCode }))
      );

      for (const po of purchaseOrders) {
        const key = `${po.companyCode}|${po.poNumber}`;
        if (!po.poNumber || alreadySent.has(key)) continue;
        try {
          const checkpoint = await this.workflowProgress.get(po.poNumber, po.companyCode);
          if (checkpoint) workflowTracked.add(key);
        } catch (error) {
          console.warn(
            `[PoMailService] Persistent PO-mail duplicate check unavailable for PO ${po.poNumber}: ${error.message}`
          );
          // Fail closed for live runs: without the persistent workflow checkpoint,
          // this process cannot prove that a candidate is genuinely new. Sending
          // here could re-mail every same-day PO after a restart.
          workflowCheckUnavailable = true;
          break;
        }
      }
    }

    if (workflowCheckUnavailable && !dryRun && !args.force) {
      result.degraded = true;
      result.finishedAt = new Date().toISOString();
      result.message = 'No PO mail sent: persistent workflow checkpoint is unavailable. Restore DB access before live polling.';
      console.error(`[PoMailService] run ${runId}: ${result.message}`);
      return result;
    }

    const pending = purchaseOrders.filter((po) => {
      if (!po.poNumber) return false;
      const key = `${po.companyCode}|${po.poNumber}`;
      if (alreadySent.has(key) || workflowTracked.has(key)) {
        result.skippedAlreadySent += 1;
        if (workflowTracked.has(key)) {
          console.log(`[PoMailService] PO ${po.poNumber}: existing workflow checkpoint; skipping duplicate initial mail.`);
        }
        return false;
      }
      return true;
    });
    result.new = pending.length;

    // 6./7. Route + mail each pending PO. Failures are collected, never thrown.
    for (const po of pending) {
      const outcome = await this._processOne({ po, routing, smtpConfig, runId, actor, dryRun, startedAt });
      result.purchaseOrders.push(outcome.entry);
      if (outcome.status === 'SENT') result.mailed += 1;
      else if (outcome.status === 'DRY_RUN') result.dryRunPrepared += 1;
      else if (outcome.status === 'AUTO_APPROVED') result.skippedAutoApprove += 1;
      else if (outcome.status === 'NO_APPROVER' || outcome.status === 'NO_RULE') result.skippedNoApprover += 1;
      else result.failed += 1;
    }

    result.finishedAt = new Date().toISOString();
    if (!dryRun) {
      if (windowTruncated) {
        console.warn(
          `[PoMailService] run ${runId}: watermark HELD — the CreationDate window was not fully read; ` +
          'unread POs are retried on the next tick (no PO will be skipped).'
        );
      } else {
        this.repository.setLastRunWatermark(startedAt);
      }
    }
    result.message = this._summarize(result);
    console.log(`[PoMailService] run ${runId}: ${result.message}`);
    return result;
  }

  /**
   * Mail ONE purchase order that the caller already has (e.g. a CAP handler
   * right after the PO was created). Accepts the raw S/4HANA/CDS row.
   */
  async sendForPurchaseOrder({ purchaseOrder, items = [], companyCode = '', documentType = '', dryRun = false, actor = Constants.SYSTEM_USER } = {}) {
    const runId = uuid();
    const smtpConfig = await this.sender.config();
    const routing = this.Routing.fromConfig(smtpConfig);
    const header = { ...(purchaseOrder || {}) };
    if (companyCode) header.CompanyCode = header.CompanyCode || companyCode;
    if (documentType) header.PurchaseOrderType = header.PurchaseOrderType || documentType;

    const po = this._normalize(header, Array.isArray(items) && items.length ? items : Mapper.resolveItemRows(header));
    const outcome = await this._processOne({ po, routing, smtpConfig, runId, actor, dryRun, startedAt: new Date() });
    return { runId, ...outcome.entry };
  }

  /** Dump the parsed routing rules (debug helper — contains no secrets). */
  async describeRouting() {
    const smtpConfig = await this.sender.config();
    const routing = this.Routing.fromConfig(smtpConfig);
    return {
      mailDestination: smtpConfig.source,
      smtp: { host: smtpConfig.host, port: smtpConfig.port, user: smtpConfig.user, from: smtpConfig.from },
      routing: routing.describe(),
      log: this.repository.describe()
    };
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  /**
   * One PO: route -> recipients -> template -> send -> log.
   * Always resolves; never throws.
   */
  async _processOne({ po, routing, smtpConfig, runId, actor, dryRun, startedAt }) {
    const base = {
      poNumber: po.poNumber,
      companyCode: po.companyCode,
      documentType: po.documentType,
      supplier: po.supplierName,
      netPoValue: po.totals.totalAmount,
      currency: po.currency,
      status: 'FAILED',
      recipients: [],
      ruleId: '',
      approvalLevel: Constants.TRIGGER_APPROVAL_LEVEL,
      messageId: '',
      error: ''
    };

    let rule;
    try {
      rule = routing.resolve(po.companyCode, po.documentType);
      base.ruleId = rule.ruleId;
    } catch (error) {
      base.status = 'NO_RULE';
      base.error = error.message;
      console.error(`[PoMailService] PO ${po.poNumber}: ${error.message}`);
      await this._log({ base, po, actor, runId, dryRun });
      return { status: base.status, entry: base };
    }

    // ZTRP-style documents need no approval -> no mail.
    if (routing.isAutoApprove(rule)) {
      base.status = 'AUTO_APPROVED';
      await this._log({ base, po, actor, runId, dryRun });
      return { status: base.status, entry: base };
    }

    const recipients = routing.recipientsForLevel(rule, Constants.TRIGGER_APPROVAL_LEVEL);
    if (!recipients.length) {
      base.status = 'NO_APPROVER';
      base.error = `Rule ${rule.ruleId} has no valid approver address at level ${Constants.TRIGGER_APPROVAL_LEVEL}.`;
      console.error(`[PoMailService] PO ${po.poNumber}: ${base.error}`);
      await this._log({ base, po, actor, runId, dryRun });
      return { status: base.status, entry: base };
    }
    base.recipients = recipients;

    // Remarks come from the S/4HANA PurchaseOrderNote PlainLongText field.
    // Keep the legacy CDS header text as a fallback if the note is absent or
    // the secondary API request is unavailable.
    await this._enrichRemarks(po);

    const logo = await this.sender.logoAttachment();
    const { subject, html } = buildPoApprovalMail({
      po,
      to: recipients,
      routing: {
        ruleId: rule.ruleId,
        action: rule.action,
        chain: routing.approvalChain(rule),
        sourceDestination: Constants.S4_DESTINATION,
        mailDestination: Constants.SMTP_DESTINATION
      },
      triggerLevel: Constants.TRIGGER_APPROVAL_LEVEL,
      environment: getMailEnvironment(),
      logoAvailable: logo.available,
      runStamp: formatRunStamp(startedAt, Constants.TIME_ZONE),
      degraded: false,
      dryRun,
      greeting: 'This is a notification only. Please open SAP S/4HANA My Inbox to review and approve the purchase order.'
    });

    const sendResult = await this.sender.send({
      // Mail header form (comma-separated string), never an array.
      to: recipients.join(', '),
      cc: [],
      bcc: [],
      subject,
      html,
      dryRun
    });

    // dryRun is checked first so a dry run can never be counted as "mailed",
    // whatever the transport reports.
    if (dryRun || sendResult.dryRun) {
      base.status = 'DRY_RUN';
      base.subject = subject;
    } else if (sendResult.sent) {
      base.status = 'SENT';
      base.messageId = sendResult.messageId;
    } else {
      base.status = 'FAILED';
      base.error = sendResult.error;
    }

    if (base.status === 'SENT') {
      await this._initializeS4WorkflowProgress({ po, rule, routing });
    }

    await this._log({ base, po, actor, runId, dryRun });
    return { status: base.status, entry: base };
  }

  /**
   * Save a persistent marker after the initial mail succeeds. The existing
   * workflow table is used for both multi-level checkpoints and one-level
   * sent-state protection; no additional CDS entity is required.
   */
  async _initializeS4WorkflowProgress({ po, rule, routing }) {
    const chain = routing.approvalChain(rule) || [];
    if (!chain.length) return;

    const hasCounter = po.workflowCompletedDialogTasks !== null
      && po.workflowCompletedDialogTasks !== undefined
      && po.workflowCompletedDialogTasks !== ''
      && Number.isFinite(Number(po.workflowCompletedDialogTasks));
    const completedTasks = hasCounter ? Number(po.workflowCompletedDialogTasks) : 0;

    if (!hasCounter && chain.length >= 2) {
      console.warn(
        `[PoMailService] S/4 workflow counter missing for PO ${po.poNumber}; ` +
        'saving a persistent initial-mail marker with baseline 0, but later-level detection requires ' +
        'NmbrOfCmpltdWrkflwDialogTasks in the CDS view.'
      );
    }

    try {
      await this.workflowProgress.initialize({
        poNumber: po.poNumber,
        companyCode: po.companyCode,
        documentType: po.documentType,
        ruleId: rule.ruleId,
        completedTasks,
        maxLevel: chain.length
      });
    } catch (error) {
      console.error(`[PoMailService] Could not initialize workflow tracking for PO ${po.poNumber}: ${error.message}`);
    }
  }

  /**
   * Detect S/4 My Inbox approvals by polling the completed-task counter.
   * A counter increase from N means level N+1 is next, using the routing
   * chain from the mail destination. No PO-specific approvers or tax/workflow
   * values are hardcoded here.
   */
  async _pollS4WorkflowProgress(args) {
    if (this._s4WorkflowPollInFlight) {
      console.warn('[PoMailService] S/4 workflow poll already in progress; skipping overlapping poll.');
      return;
    }
    this._s4WorkflowPollInFlight = true;
    try {
      return await this._pollS4WorkflowProgressCore(args);
    } finally {
      this._s4WorkflowPollInFlight = false;
    }
  }

  async _pollS4WorkflowProgressCore({ routing, smtpConfig }) {
    let states;
    try {
      states = await this.workflowProgress.listActive();
    } catch (error) {
      console.warn(`[PoMailService] S/4 workflow polling skipped: ${error.message}`);
      return;
    }

    for (const state of states || []) {
      const poNumber = String(state.PO_NUMBER || '');
      const companyCode = String(state.COMPANY_CODE || '');
      try {
        const fetched = await this.client.getPurchaseOrders({
          purchaseOrder: poNumber,
          companyCode,
          documentType: state.DOCUMENT_TYPE || ''
        });
        const row = (fetched.rows || []).find((entry) =>
          Mapper.HEADER.completedWorkflowDialogTasks(entry) !== null
          || Mapper.HEADER.purchasingProcessingStatus(entry)
        );
        if (!row) continue;

        // Prefer the standard S/4 PO API status on every poll. The custom
        // YY1 view may report a completed-looking value after a My Inbox
        // rejection; trusting that value could incorrectly send the next level.
        // If the authoritative API read fails/returns blank, fail closed rather
        // than using a possibly stale view status to advance the workflow.
        let statusRow = row;
        let status = '';
        if (typeof this.client.getPurchaseOrderProcessingStatus === 'function') {
          // Do not fall back to a possibly stale custom-view status when the
          // authoritative API is available but its read fails or is blank.
          statusRow = { ...row };
          for (const field of new Set([
            Constants.PROCESSING_STATUS_FIELD,
            'PurchasingProcessingStatus',
            'PurchaseOrderProcessingStatus',
            'PurchasingDocumentProcessingStatus',
            'PROCSTAT',
            'PO_PROCESSING_STATUS'
          ])) statusRow[field] = '';
          try {
            status = String(await this.client.getPurchaseOrderProcessingStatus(poNumber) || '').trim();
            if (status) {
              statusRow = { ...row, [Constants.PROCESSING_STATUS_FIELD]: status };
            } else {
              console.warn(`[PoMailService] Standard PO API returned no processing status for PO ${poNumber}.`);
            }
          } catch (error) {
            console.warn(
              `[PoMailService] Could not read authoritative processing status for PO ${poNumber}: ${error.message}`
            );
          }
        } else {
          // Compatibility path for test clients or integrations without the
          // standard PO API method; the production S4PoClient provides it.
          status = Mapper.HEADER.purchasingProcessingStatus(row);
        }
        const completedTasks = Mapper.HEADER.completedWorkflowDialogTasks(row);
        const activeTasks = Mapper.HEADER.activeWorkflowDialogTasks(row);
        const lastCompletedTasks = Number(state.LAST_COMPLETED_TASKS || 0);
        console.log(
          `[PoMailService] PO ${poNumber} workflow poll: status='${status || 'UNKNOWN'}', ` +
          `completedTasks=${completedTasks ?? 'UNKNOWN'}, activeTasks=${activeTasks ?? 'UNKNOWN'}, ` +
          `checkpointTasks=${lastCompletedTasks}.`
        );

        let rule;
        try {
          rule = routing.resolve(companyCode, state.DOCUMENT_TYPE || Mapper.HEADER.documentType(row));
        } catch (error) {
          console.error(`[PoMailService] Cannot resolve workflow route for PO ${poNumber}: ${error.message}`);
          continue;
        }

        const chain = routing.approvalChain(rule) || [];
        const documentType = state.DOCUMENT_TYPE || Mapper.HEADER.documentType(row);

        // Rejection is terminal and takes precedence over task-count increases.
        // Prefer the standard API's rejected code. The YY1 workflow counters
        // also provide a rejection signal: when a newly completed task leaves
        // fewer than all configured approval levels complete and S/4 reports
        // zero active tasks, the workflow has ended before the next approver.
        // Do not infer rejection from zero active tasks after all levels have
        // completed, or when S/4 affirmatively reports final approval.
        // A rejection signal from EITHER source is terminal. The standard API
        // is preferred for progression, but right after a My Inbox rejection it
        // can briefly fail or still report an active status while the custom
        // view already shows 08. Trusting only the API in that window would let
        // a task-count increase send a next-level mail after the rejection.
        const rejectedByStatus = Mapper.HEADER.isRejected(statusRow)
          || Mapper.HEADER.isRejected(row);
        const rejectedByWorkflowEnd = completedTasks !== null
          && completedTasks > lastCompletedTasks
          && completedTasks < chain.length
          && activeTasks === 0
          && !Mapper.HEADER.isFinalApprovedStatus(statusRow);
        if (rejectedByStatus || rejectedByWorkflowEnd) {
          const configuredLevels = chain.map((entry) => Number(entry.level)).filter(Number.isFinite).sort((a, b) => a - b);
          const rejectedLevel = configuredLevels.find((level) => level > lastCompletedTasks)
            ?? configuredLevels[configuredLevels.length - 1]
            ?? 1;
          if (rejectedByWorkflowEnd && !rejectedByStatus) {
            console.log(
              `[PoMailService] PO ${poNumber}: completed-task count ${completedTasks} is below ` +
              `the ${chain.length}-level route and active-task count is 0; treating workflow as rejected.`
            );
          }
          const rejection = await this._sendRejectionMail({
            poNumber, companyCode, documentType, rule, chain, rejectedLevel, smtpConfig
          });
          if (!rejection.ok) {
            console.error(`[PoMailService] Rejection notice for PO ${poNumber} failed: ${rejection.error}`);
            continue; // Leave ACTIVE so the next poll retries delivery.
          }
          await this.workflowProgress.advance({
            poNumber,
            companyCode,
            completedTasks: completedTasks === null ? lastCompletedTasks : completedTasks,
            trackingStatus: 'REJECTED'
          });
          console.log(
            `[PoMailService] PO ${poNumber} rejected in S/4HANA; notified ` +
            `${rejection.recipients.length} recipient(s); tracking is terminal REJECTED.`
          );
          continue;
        }

        if (completedTasks === null || completedTasks <= lastCompletedTasks) continue;

        // Require the S/4 processing status before advancing. Without it, a
        // rejected task could look identical to an approval-counter increase.
        if (!status) {
          console.warn(
            `[PoMailService] PO ${poNumber}: workflow counter increased but ` +
            `${Constants.PROCESSING_STATUS_FIELD} is missing from the S/4 view; ` +
            'failing closed without sending a next-level or completion notice.'
          );
          continue;
        }
        if (!Mapper.HEADER.isActiveWorkflowStatus(statusRow) && !Mapper.HEADER.isFinalApprovedStatus(statusRow)) {
          console.warn(
            `[PoMailService] PO ${poNumber}: unrecognized/non-progressing S/4 status '${status}'; ` +
            'workflow notification progression is held for safety.'
          );
          continue;
        }

        if (routing.isAutoApprove(rule)) {
          await this.workflowProgress.advance({
            poNumber,
            companyCode,
            completedTasks,
            trackingStatus: 'COMPLETE'
          });
          continue;
        }

        // Catch up every sequential stage if S/4's task count advanced by
        // more than one between polls. For a three-level PO: count 1 sends
        // Level 2; count 2 sends Level 3; count 3 sends completion only after
        // S/4 reports an affirmative final-approved processing status.
        let retryThisPo = false;
        for (let observedCompleted = lastCompletedTasks + 1;
          observedCompleted <= completedTasks;
          observedCompleted += 1) {
          if (observedCompleted >= chain.length) {
            if (!Mapper.HEADER.isFinalApprovedStatus(statusRow)) {
              console.warn(
                `[PoMailService] PO ${poNumber} reached the final task count but S/4 status ` +
                `'${status}' is not a confirmed approved status; withholding completion notice.`
              );
              break;
            }
            const completion = await this._sendCompletionMail({
              poNumber,
              companyCode,
              documentType,
              rule,
              chain,
              smtpConfig
            });
            if (!completion.ok) {
              console.error(`[PoMailService] Completion notification for PO ${poNumber} failed: ${completion.error}`);
              retryThisPo = true;
              break; // Keep the previous checkpoint so the next poll can retry.
            }

            await this.workflowProgress.advance({
              poNumber,
              companyCode,
              completedTasks,
              trackingStatus: 'COMPLETE'
            });
            console.log(
              `[PoMailService] S/4 workflow completed for PO ${poNumber}; sent completion notice to ` +
              `${completion.recipients.length} recipient(s).`
            );
            break;
          }

          const nextLevel = observedCompleted + 1;

          // When the standard status is still 03 (in workflow), require an
          // active task before advancing to another approver. Status 05 is the
          // user's confirmed approval-stage signal, so a task-count increase
          // with 05 can notify the next level even if the active-task counter
          // has not refreshed yet. Final completion is handled only when the
          // completed count reaches the configured chain length.
          if (observedCompleted === completedTasks
            && observedCompleted < chain.length
            && Mapper.HEADER.isActiveWorkflowStatus(statusRow)) {
            if (activeTasks === null || activeTasks < 1) {
              console.warn(
                `[PoMailService] PO ${poNumber} task count advanced to ${observedCompleted} but S/4 ` +
                'reports no active workflow task; withholding the next-level notification until the ' +
                'workflow state is clear.'
              );
              break;
            }
          }

          const sent = await this._sendLevelMail({
            poNumber,
            companyCode,
            documentType,
            rule,
            chain,
            level: nextLevel,
            dryRun: false,
            smtpConfig
          });
          if (!sent.ok) {
            console.error(`[PoMailService] Level ${nextLevel} notification for PO ${poNumber} failed: ${sent.error}`);
            retryThisPo = true;
            break; // Keep this stage's checkpoint so the next poll retries it.
          }

          await this.workflowProgress.advance({
            poNumber,
            companyCode,
            completedTasks: observedCompleted,
            trackingStatus: 'ACTIVE'
          });
          console.log(
            `[PoMailService] S/4 completed-task count for PO ${poNumber} is ${observedCompleted}; ` +
            `notified level ${nextLevel}.`
          );
        }
        if (retryThisPo) continue;
      } catch (error) {
        console.error(`[PoMailService] S/4 workflow poll failed for PO ${poNumber}: ${error.message}`);
      }
    }
  }

  /** Load the selected header note into the mail's existing Remarks field. */
  async _enrichRemarks(po) {
    if (!po?.poNumber || typeof this.client?.getPurchaseOrderRemarks !== 'function') return po;
    try {
      const remarks = await this.client.getPurchaseOrderRemarks(po.poNumber);
      if (String(remarks ?? '').trim()) {
        po.headerText = String(remarks).trim();
      } else {
        console.warn(
          `[PoMailService] No Remarks text returned for PO ${po.poNumber}; ` +
          'keeping the existing CDS header text, if available.'
        );
      }
    } catch (error) {
      console.warn(
        `[PoMailService] Could not read Remarks PlainLongText for PO ${po.poNumber}: ${error.message}. ` +
        'Using the existing PO CDS header text, if available.'
      );
    }
    return po;
  }

  async _log({ base, po, actor, runId, dryRun }) {
    if (dryRun) return;
    try {
      await this.repository.record({
        poNumber: base.poNumber,
        companyCode: base.companyCode,
        documentType: base.documentType,
        status: base.status,
        recipients: (base.recipients || []).join(','),
        ruleId: base.ruleId,
        approvalLevel: base.approvalLevel,
        messageId: base.messageId,
        errorMessage: base.error,
        runId,
        actor
      });
    } catch (error) {
      console.warn(`[PoMailService] Could not write mail log for PO ${po?.poNumber}: ${error.message}`);
    }
  }

  /**
   * Stable key for an item row so repeated rows from an expanded/joined OData
   * response do not create repeated lines in the email. SAP PO item numbers
   * are the primary identity; a row signature is used when the item number is
   * not present in the CDS projection.
   */
  _itemRowIdentity(row) {
    const itemNumber = Mapper.firstPresent(row, [
      'PurchaseOrderItem', 'ItemNumber', 'Item', 'PO_ITEM', 'EBELP', 'LineItem', 'ItemNo'
    ]);
    if (itemNumber) {
      const normalized = /^\d+$/.test(itemNumber)
        ? String(Number(itemNumber))
        : itemNumber;
      return `item:${normalized}`;
    }

    const signature = [
      Mapper.ITEM.itemCode(row),
      Mapper.ITEM.description(row),
      Mapper.ITEM.deliveryDate(row),
      Mapper.ITEM.quantity(row),
      Mapper.ITEM.quantityUnit(row),
      Mapper.ITEM.unitPrice(row),
      Mapper.ITEM.plant(row)
    ].map((value) => String(value ?? '').trim()).join('|');
    return `row:${signature}`;
  }

  /**
   * Numeric sort value of an item row's SAP item number (00010 → 10), or
   * null when the row carries no recognisable item number.
   */
  _itemSortValue(row) {
    const itemNumber = Mapper.firstPresent(row, [
      'PurchaseOrderItem', 'ItemNumber', 'Item', 'PO_ITEM', 'EBELP', 'LineItem', 'ItemNo'
    ]);
    if (!itemNumber) return null;
    const numeric = Number(itemNumber);
    return Number.isFinite(numeric) ? numeric : null;
  }

  /**
   * Order item rows exactly as SAP numbers them (00010, 00020, 00030 …),
   * regardless of the order the flat CDS view returned them. Rows without a
   * recognisable item number keep their original relative order after the
   * numbered ones — no ordering is hardcoded, it comes from the data.
   */
  _sortItemRows(itemRows = []) {
    return itemRows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const av = this._itemSortValue(a.row);
        const bv = this._itemSortValue(b.row);
        if (av !== null && bv !== null) {
          if (av !== bv) return av - bv;
        } else if (av !== null) {
          return -1; // numbered items first
        } else if (bv !== null) {
          return 1;
        }
        return a.index - b.index; // stable: keep the view's order
      })
      .map((entry) => entry.row);
  }

  /**
   * Group the OData rows into one PO per number, then normalise.
   * Handles both a header/item CDS view (expand) and a flat per-item view,
   * while de-duplicating each PO item by its SAP item number.
   */
  _groupAndNormalize(rows = []) {
    const grouped = new Map();

    const getGroup = (poNumber, row) => {
      if (!grouped.has(poNumber)) {
        grouped.set(poNumber, { header: row, items: [], itemKeys: new Set() });
      }
      return grouped.get(poNumber);
    };

    const addItemsOnce = (group, itemRows) => {
      for (const itemRow of itemRows) {
        const key = this._itemRowIdentity(itemRow);
        if (group.itemKeys.has(key)) continue;
        group.itemKeys.add(key);
        group.items.push(itemRow);
      }
    };

    for (const row of rows) {
      const poNumber = Mapper.HEADER.poNumber(row);
      if (!poNumber) continue;

      const itemRows = Mapper.resolveItemRows(row);
      const group = getGroup(poNumber, row);

      if (itemRows.length) {
        // Header row carrying its items (expand). The same expanded item set
        // can recur on multiple rows after CDS joins; add each item only once.
        addItemsOnce(group, itemRows);
      } else {
        // Flat row: the row itself is one item (header fields are repeated).
        addItemsOnce(group, [row]);
      }
    }

    const list = [];
    for (const [, { header, items }] of grouped) {
      list.push(this._normalize(header, items));
    }
    return list;
  }

  /** Map one S/4HANA row set onto the exact field set the mail template needs. */
  _normalize(header, itemRows = []) {
    const currency = Mapper.HEADER.currency(header);
    const moneyDecimals = Mapper.HEADER.currencyDecimals(header) || 2;
    const qtyDecimals = Mapper.HEADER.quantityDecimals(header) || 3;

    // Render line items in SAP item-number order (Sl. No 1, 2, 3 …) even when
    // the flat view returned the rows in a different sequence.
    const orderedItemRows = this._sortItemRows(itemRows);

    const items = orderedItemRows.map((row, index) => {
      const quantity = Mapper.ITEM.quantity(row);
      const priceUnit = Mapper.ITEM.priceUnit(row) || 1;
      const unitPrice = Mapper.ITEM.unitPrice(row);
      const mappedTaxPercent = Mapper.ITEM.taxPercent(row);

      // Derive whatever the CDS view does not deliver, so the mail is complete.
      const basePrice = Mapper.round(
        Mapper.ITEM.basePrice(row) || (quantity * unitPrice) / (priceUnit || 1),
        moneyDecimals
      );
      const tax = Mapper.round(
        Mapper.ITEM.tax(row) || (basePrice * (mappedTaxPercent ?? 0)) / 100,
        moneyDecimals
      );
      const total = Mapper.round(Mapper.ITEM.total(row) || basePrice + tax, moneyDecimals);
      // If S/4 supplies tax amount but not its percentage, derive the rate.
      // Do not show a misleading 0% when the rate is absent and tax is zero.
      const taxPercent = mappedTaxPercent !== null
        ? mappedTaxPercent
        : (basePrice > 0 && tax > 0 ? (tax / basePrice) * 100 : null);

      const unit = Mapper.ITEM.quantityUnit(row);
      return {
        slNo: Mapper.ITEM.slNo(row, index),
        item: Mapper.ITEM.itemCode(row) || Mapper.ITEM.slNo(row, index),
        description: Mapper.ITEM.description(row),
        deliveryDate: Mapper.ITEM.deliveryDate(row),
        quantity: formatQuantity(quantity, unit, qtyDecimals),
        unitPrice: formatAmount(unitPrice, currency, moneyDecimals),
        taxPercent: taxPercent !== null
          ? formatPercent(taxPercent)
          : (Mapper.ITEM.taxCode(row) || ''),
        basePrice: formatAmount(basePrice, currency, moneyDecimals),
        tax: formatAmount(tax, currency, moneyDecimals),
        total: formatAmount(total, currency, moneyDecimals),
        // numeric copies for the header totals
        _basePrice: basePrice,
        _tax: tax,
        _total: total
      };
    });

    // Totals are the SUM OF THE LINE ITEMS — the source of truth. On a flat
    // PO/item CDS view a header column can repeat an item-level value (e.g.
    // the first row's net price), which made a multi-item PO show only its
    // first item as "Total Base Price". Header totals are therefore used ONLY
    // when the view delivered no line items at all. No values are hardcoded:
    // every total is derived from the rows S/4 returns.
    const sumBasePrice = items.reduce((sum, item) => sum + item._basePrice, 0);
    const sumTax = items.reduce((sum, item) => sum + item._tax, 0);
    const sumAmount = items.reduce((sum, item) => sum + item._total, 0);
    const totalBasePrice = Mapper.round(
      items.length ? sumBasePrice : Mapper.HEADER.totalBasePrice(header),
      moneyDecimals
    );
    const totalTax = Mapper.round(
      items.length ? sumTax : Mapper.HEADER.totalTax(header),
      moneyDecimals
    );
    const totalAmount = Mapper.round(
      items.length ? sumAmount : Mapper.HEADER.totalAmount(header),
      moneyDecimals
    );

    return {
      poNumber: Mapper.HEADER.poNumber(header),
      companyCode: Mapper.HEADER.companyCode(header),
      documentType: Mapper.HEADER.documentType(header),
      creatorEmail: Mapper.HEADER.creatorEmail(header),
      createdOn: Mapper.HEADER.createdOn(header),
      createdBy: Mapper.HEADER.createdBy(header),
      purchasingOrganization: Mapper.HEADER.purchasingOrganization(header),
      purchasingGroup: Mapper.HEADER.purchasingGroup(header),
      currency,
      workflowCompletedDialogTasks: Mapper.HEADER.completedWorkflowDialogTasks(header),
      workflowActiveDialogTasks: Mapper.HEADER.activeWorkflowDialogTasks(header),
      paymentTerms: Mapper.HEADER.paymentTerms(header),
      headerText: Mapper.HEADER.headerText(header),
      supplierCode: Mapper.HEADER.supplierCode(header),
      supplierName: Mapper.HEADER.supplierName(header),
      supplierAddress: Mapper.HEADER.supplierAddress(header),
      supplierTaxNumber: Mapper.HEADER.supplierTaxNumber(header),
      companyName: Mapper.HEADER.companyName(header),
      companyAddress: Mapper.HEADER.companyAddress(header),
      items,
      totals: {
        totalBasePrice: formatMoney(totalBasePrice, currency, moneyDecimals),
        totalTax: formatMoney(totalTax, currency, moneyDecimals),
        totalAmount: formatMoney(totalAmount, currency, moneyDecimals),
        totalAmountInWords: amountInWords(totalAmount, currency),
        // numeric copies (useful for tests / downstream logic)
        totalBasePriceValue: totalBasePrice,
        totalTaxValue: totalTax,
        totalAmountValue: totalAmount
      },
      raw: header
    };
  }

  _summarize(result) {
    const parts = [
      `${result.read} PO read`,
      `${result.new} new`,
      result.dryRun
        ? `${result.dryRunPrepared} mail(s) prepared (dry run, nothing sent)`
        : `${result.mailed} mailed`,
      `${result.skippedAlreadySent} already sent`,
      `${result.skippedAutoApprove} auto-approved`,
      `${result.skippedNoApprover} without approver`,
      `${result.failed} failed`
    ];
    const summary = parts.join(', ') + '.';
    return result.truncated
      ? `${summary} Window TRUNCATED — watermark held, unread POs retry next tick.`
      : summary;
  }

  /** Build + send a notification for the S/4HANA My Inbox level. */
  async _sendLevelMail({ poNumber, companyCode, documentType, rule, chain, level, dryRun, smtpConfig }) {
    const empty = { ok: false, recipients: [], messageId: '', error: '' };
    try {
      const fetched = await this.client.getPurchaseOrders({ purchaseOrder: poNumber, companyCode, documentType });
      const [po] = this._groupAndNormalize(fetched.rows || []);
      if (!po) return { ...empty, error: `PO ${poNumber} not found in the S/4 view.` };
      await this._enrichRemarks(po);

      const recipients = (chain.find((entry) => entry.level === level)?.recipients) || [];
      if (!recipients.length) return { ...empty, error: `Rule ${rule.ruleId} has no approvers at level ${level}.` };

      const logo = await this.sender.logoAttachment();
      const { subject, html } = buildPoApprovalMail({
        po,
        to: recipients,
        routing: {
          ruleId: rule.ruleId, action: rule.action, chain,
          sourceDestination: Constants.S4_DESTINATION, mailDestination: Constants.SMTP_DESTINATION
        },
        triggerLevel: level,
        environment: getMailEnvironment(),
        logoAvailable: logo.available,
        runStamp: formatRunStamp(new Date(), Constants.TIME_ZONE),
        greeting: `The S/4HANA workflow has advanced. This purchase order is awaiting review at ` +
          `<b>Level ${level}</b>. Please complete the approval in S/4HANA My Inbox.`
      });

      const sendResult = await this.sender.send({
        to: recipients.join(', '),
        cc: [],
        bcc: [],
        subject,
        html,
        dryRun
      });
      if (dryRun || sendResult.dryRun) return { ok: true, recipients, messageId: '', error: '' };
      if (sendResult.sent) return { ok: true, recipients, messageId: sendResult.messageId || '', error: '' };
      return { ...empty, recipients, error: sendResult.error || 'send failed' };
    } catch (error) {
      return { ...empty, error: error.message };
    }
  }

  /**
   * Send one rejection notice to configured recipients from earlier levels.
   * A Level 1 rejection goes to its configured Level 1 recipient; no creator
   * lookup is required.
   */
  async _sendRejectionMail({ poNumber, companyCode, documentType, rule, chain, rejectedLevel, smtpConfig }) {
    const empty = { ok: false, recipients: [], messageId: '', error: '' };
    try {
      const fetched = await this.client.getPurchaseOrders({ purchaseOrder: poNumber, companyCode, documentType });
      const [po] = this._groupAndNormalize(fetched.rows || []);
      if (!po) return { ...empty, error: `PO ${poNumber} not found in the S/4 view.` };
      await this._enrichRemarks(po);

      // Level 1 has no earlier approver, so notify its own configured recipient.
      // For later rejections, notify only configured approvers from earlier levels.
      const configuredRejectingLevel = (chain || []).find(
        (entry) => Number(entry.level) === Number(rejectedLevel)
      );
      if (!configuredRejectingLevel) {
        return { ...empty, error: `Rule ${rule.ruleId} has no configured Level ${rejectedLevel} in its approval chain.` };
      }
      const recipientLevels = Number(rejectedLevel) === 1
        ? [configuredRejectingLevel]
        : (chain || []).filter((entry) => Number(entry.level) < Number(rejectedLevel));
      const recipients = [...new Set(
        recipientLevels.flatMap((entry) => entry.recipients || [])
          .map((address) => String(address || '').trim().toLowerCase())
          .filter((address) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address))
      )];
      if (!recipients.length) {
        return { ...empty, error: `Rule ${rule.ruleId} has no valid configured previous-level recipients for rejection at Level ${rejectedLevel}.` };
      }

      const logo = await this.sender.logoAttachment();
      const { subject, html } = buildPoApprovalMail({
        po,
        to: recipients,
        routing: {
          ruleId: rule.ruleId,
          action: rule.action,
          // Keep the full configured chain for the mail's approval-flow display;
          // the SMTP recipient list above remains limited to earlier levels.
          chain,
          sourceDestination: Constants.S4_DESTINATION,
          mailDestination: Constants.SMTP_DESTINATION
        },
        triggerLevel: Number(rejectedLevel),
        rejectedLevel: Number(rejectedLevel),
        notificationType: 'REJECTED',
        environment: getMailEnvironment(),
        logoAvailable: logo.available,
        runStamp: formatRunStamp(new Date(), Constants.TIME_ZONE),
        greeting: Number(rejectedLevel) === 1
          ? 'The purchase order was rejected at Level 1 in SAP S/4HANA My Inbox. This notice is sent to the configured Level 1 recipient.'
          : `The purchase order was rejected at Level ${rejectedLevel} in SAP S/4HANA My Inbox. This notice is sent to configured approvers from earlier levels only.`
      });

      const sendResult = await this.sender.send({
        to: recipients.join(', '),
        cc: [],
        bcc: [],
        subject,
        html,
        dryRun: false
      });
      if (sendResult.sent) {
        return { ok: true, recipients, messageId: sendResult.messageId || '', error: '' };
      }
      return { ...empty, recipients, error: sendResult.error || 'send failed' };
    } catch (error) {
      return { ...empty, error: error.message };
    }
  }

  /** Send final completion notice to all configured approvers in the route. */
  async _sendCompletionMail({ poNumber, companyCode, documentType, rule, chain, smtpConfig }) {
    const empty = { ok: false, recipients: [], messageId: '', error: '' };
    try {
      const fetched = await this.client.getPurchaseOrders({ purchaseOrder: poNumber, companyCode, documentType });
      const [po] = this._groupAndNormalize(fetched.rows || []);
      if (!po) return { ...empty, error: `PO ${poNumber} not found in the S/4 view.` };
      await this._enrichRemarks(po);

      // Final approval completion goes to all configured approvers in the route.
      const recipients = [...new Set(
        (chain || []).flatMap((entry) => entry.recipients || [])
          .map((address) => String(address || '').trim().toLowerCase())
          .filter((address) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(address))
      )];
      if (!recipients.length) {
        return { ...empty, error: `Rule ${rule.ruleId} has no valid configured approvers for the completion notice.` };
      }

      const logo = await this.sender.logoAttachment();
      const { subject, html } = buildPoApprovalMail({
        po,
        to: recipients,
        routing: {
          ruleId: rule.ruleId,
          action: rule.action,
          chain,
          sourceDestination: Constants.S4_DESTINATION,
          mailDestination: Constants.SMTP_DESTINATION
        },
        triggerLevel: (chain || []).length + 1,
        notificationType: 'COMPLETED',
        environment: getMailEnvironment(),
        logoAvailable: logo.available,
        runStamp: formatRunStamp(new Date(), Constants.TIME_ZONE),
        greeting: 'The purchase order has been approved at all configured levels in SAP S/4HANA My Inbox. This completion notice is sent to all configured approvers.'
      });

      const sendResult = await this.sender.send({
        to: recipients.join(', '),
        cc: [],
        bcc: [],
        subject,
        html,
        dryRun: false
      });
      if (sendResult.sent) {
        return { ok: true, recipients, messageId: sendResult.messageId || '', error: '' };
      }
      return { ...empty, recipients, error: sendResult.error || 'send failed' };
    } catch (error) {
      return { ...empty, error: error.message };
    }
  }
}

module.exports = PoMailService;
