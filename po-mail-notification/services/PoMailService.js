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

    // Recovery: report any checkpoint rows left in SENDING by a crash or DB
    // disconnection between claim and finalize. These rows are NOT auto-reset
    // to ACTIVE — if the mail was actually sent but finalize() failed, resetting
    // would cause a duplicate send. They stay in SENDING to block re-sends.
    // If a row is genuinely stuck (mail was never sent), use forceResetSending
    // to release it manually.
    try {
      const stale = await this.workflowProgress.findStaleSending();
      if (stale && stale.length) {
        console.warn(
          `[PoMailService] Startup recovery: ${stale.length} PO checkpoint(s) stuck in SENDING ` +
          '(mail may have been sent before a DB disconnection). Leaving them in SENDING to block ' +
          'duplicate sends. Use forceResetSending to manually release a row if the mail was NOT sent.'
        );
        for (const row of stale) {
          console.warn(
            `[PoMailService] Stuck SENDING: PO ${row.PO_NUMBER} (Company ${row.COMPANY_CODE}), ` +
            `tasks=${row.LAST_COMPLETED_TASKS}`
          );
        }
      }
    } catch (error) {
      console.warn(
        `[PoMailService] Startup recovery (findStaleSending) failed: ${error.message}. ` +
        'Stuck SENDING rows will be reported on a later run.'
      );
    }

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
    // INCREMENTAL SCAN WINDOW (today mode): after a scan completes, the
    // watermark advances to that run's start time. Subsequent scans then read
    // only rows created AFTER (watermark - 10min overlap) instead of
    // re-reading the entire 2-day window on every 1-minute tick. Re-reading
    // ~20K rows/min (20+ pages, thousands of DB checkpoint calls) never
    // finished before the next tick overlapped, exhausting the DB connection
    // pool ("Database connection is disconnected") and causing OOM kills
    // (exit 137). New POs always sort to page 1 (CreationDate desc, PurchaseOrder
    // desc) so the fast trigger still mails them within ~1 min; the 10-min
    // overlap catches anything created mid-scan. The yesterday-UTC floor
    // guarantees a full catch-up on the first run / after a crash (stale or
    // absent watermark). Rolling mode keeps its 48h overlap (unchanged).
    const yesterdayUtc = daysAgoStart(2, 'UTC');
    const todayOverlapFrom = lastRun
      ? new Date(lastRun.getTime() - (10 * 60 * 1000))
      : null;
    const todayFromDate = todayOverlapFrom && todayOverlapFrom.getTime() > yesterdayUtc.getTime()
      ? todayOverlapFrom
      : yesterdayUtc;
    const overlapFromDate = lastRun
      ? new Date(lastRun.getTime() - (48 * 60 * 60 * 1000))
      : null;
    const todayOnly = Constants.MAIL_WINDOW_MODE === 'today';
    // TODAY mode: scan from YESTERDAY's midnight UTC with no upper bound.
    // CreationDate is date-only on S/4's UTC calendar. A PO created 00:00-05:30
    // IST is stored with CreationDate = yesterday (UTC), so a filter starting
    // at TODAY's UTC midnight (daysAgoStart(0)) would miss it entirely — as
    // observed in production ("PO created just after midnight IST, no mail").
    // Starting the filter at yesterday 00:00 UTC (the incremental floor) catches
    // ALL of today's POs (both the early-morning ones stored as yesterday and the
    // rest stored as today). The watermark + duplicate protection skip
    // already-mailed POs, so only genuinely new POs get mailed. On the first run
    // this reads ~2 calendar days of rows (~2K-4K with 1K-2K POs/day); once the
    // watermark advances, re-scans read only a 10-min overlap instead of the
    // 78K+ rows the old 2-day lookback was pulling on every tick.
    // ROLLING mode: scan from the watermark overlap (last run - 48h) to open.
    // TODAY mode: incremental — from the watermark overlap (or yesterday-UTC
    // floor on first run / after a crash). ROLLING mode: 48h watermark overlap.
    // First run after restart (no watermark yet) falls back to yesterday-UTC
    // so a restart still catches POs created in the early-morning IST window.
    const fromDate = args.fromDate
      || (todayOnly ? todayFromDate : overlapFromDate)
      || yesterdayUtc;
    // TODAY mode: no upper bound (to=open) so all of today's POs are caught
    // regardless of the IST/UTC date-only offset. Rolling mode also uses
    // to=open (scans from watermark to now).
    const toDate = args.toDate || null;
    console.log(
      `[PoMailService] PO scan window: mode=${Constants.MAIL_WINDOW_MODE}, ` +
      `field=${Constants.CREATED_ON_FIELD}, timezone=${creationDateTimeZone}, ` +
      `from=${fromDate.toISOString()}, to=${toDate ? toDate.toISOString() : 'open'}.`
    );
    result.range = args.purchaseOrder
      ? { purchaseOrder: args.purchaseOrder }
      : { from: fromDate.toISOString(), to: toDate ? toDate.toISOString() : null };

    // 3. FAST TRIGGER — read page 1 only and mail any new POs immediately,
    //    before the full multi-page scan. New POs are always the newest
    //    (sorted CreationDate desc, PurchaseOrder desc) so they land on page 1.
    //    This makes a brand-new PO mail within ~1 tick instead of waiting for
    //    the entire 200-page scan to finish. The full scan below then reads
    //    every page for catch-up; duplicate protection skips POs already
    //    handled by the fast pass.
    const sharedAlreadySent = new Set();
    const sharedWorkflowTracked = new Set();
    let sharedWorkflowCheckUnavailable = false;
    let fastCapped = false;
    let fastRemaining = 0;
    // Run-level PO cap, shared across the fast trigger and every scan page so
    // the total POs processed in this run is bounded (see _mailFromRows).
    const runCap = { processed: 0, max: this._maxPoPerRun(), capped: false };

    if (!args.purchaseOrder) {
      const page1 = await this.client.getPurchaseOrders({
        fromDate,
        toDate,
        companyCode: args.companyCode || '',
        documentType: args.documentType || '',
        firstPageOnly: true
      });
      const fastOutcome = await this._mailFromRows({
        rows: page1.rows || [],
        routing, smtpConfig, runId, actor, dryRun, startedAt,
        alreadySent: sharedAlreadySent,
        workflowTracked: sharedWorkflowTracked,
        workflowCheckUnavailable: sharedWorkflowCheckUnavailable,
        force: args.force,
        runCap
      });
      sharedWorkflowCheckUnavailable = fastOutcome.workflowCheckUnavailable;
      fastCapped = fastOutcome.capped || fastCapped;
      fastRemaining = Math.max(fastRemaining, fastOutcome.remaining);
      if (fastOutcome.mailed > 0) {
        console.log(
          `[PoMailService] run ${runId}: fast page-1 trigger mailed ${fastOutcome.mailed} new PO(s) ` +
          `before the full scan (${fastOutcome.new} new on page 1).`
        );
      }
    }

    // 4. FULL SCAN — read every page in the window for catch-up. POs already
    //    mailed by the fast pass are skipped by the shared dedup sets (and the
    //    persistent mail log / workflow checkpoint).
    // 4. FULL SCAN — stream pages one at a time: read a page, mail from it,
    //    discard the rows, then read the next page. This keeps memory bounded
    //    to one page (~1000 rows) instead of accumulating all 78K+ rows in
    //    memory (which caused OOM kills / exit 137 on every scan).
    //    The shared dedup sets carry across pages, so POs mailed on page 1
    //    are skipped on page 2+.
    let totalRowsRead = 0;
    const streamOutcome = {
      new: 0, mailed: 0, dryRunPrepared: 0, skippedAlreadySent: 0,
      skippedAutoApprove: 0, skippedNoApprover: 0, failed: 0,
      purchaseOrders: [], workflowCheckUnavailable: false,
      capped: false, remaining: 0
    };

    if (args.purchaseOrder) {
      // Single-PO scan: just fetch and process directly.
      const fetched = await this.client.getPurchaseOrders({
        fromDate,
        toDate,
        purchaseOrder: args.purchaseOrder,
        companyCode: args.companyCode || '',
        documentType: args.documentType || ''
      });
      result.degraded = Boolean(fetched.degraded) || sharedWorkflowCheckUnavailable;
      result.truncated = Boolean(fetched.truncated);
      result.read = (fetched.rows || []).length;
      if (!result.read) {
        result.message = 'No purchase order found for the selected PO.';
        result.finishedAt = new Date().toISOString();
        this.repository.setLastRunWatermark(startedAt);
        return result;
      }
      const singleOutcome = await this._mailFromRows({
        rows: fetched.rows || [],
        routing, smtpConfig, runId, actor, dryRun, startedAt,
        alreadySent: sharedAlreadySent,
        workflowTracked: sharedWorkflowTracked,
        workflowCheckUnavailable: sharedWorkflowCheckUnavailable,
        force: args.force
      });
      sharedWorkflowCheckUnavailable = singleOutcome.workflowCheckUnavailable;
      Object.assign(streamOutcome, {
        new: singleOutcome.new, mailed: singleOutcome.mailed,
        dryRunPrepared: singleOutcome.dryRunPrepared,
        skippedAlreadySent: singleOutcome.skippedAlreadySent,
        skippedAutoApprove: singleOutcome.skippedAutoApprove,
        skippedNoApprover: singleOutcome.skippedNoApprover,
        failed: singleOutcome.failed,
        purchaseOrders: singleOutcome.purchaseOrders
      });
    } else {
      // Full scan: stream pages, process each, discard rows.
      const fetched = await this.client.getPurchaseOrdersPaged({
        fromDate,
        toDate,
        companyCode: args.companyCode || '',
        documentType: args.documentType || '',
        pageProcessor: async (pageRows, pageNum) => {
          totalRowsRead += pageRows.length;
          if (!pageRows.length) return false;
          // Once the run-level PO cap is hit, stop reading further pages — no
          // more POs can be mailed this tick and the rest of the window is
          // wasted I/O. Returning true tells _fetchAll to stop pagination.
          if (runCap.capped) return true;
          const pageOutcome = await this._mailFromRows({
            rows: pageRows,
            routing, smtpConfig, runId, actor, dryRun, startedAt,
            alreadySent: sharedAlreadySent,
            workflowTracked: sharedWorkflowTracked,
            workflowCheckUnavailable: sharedWorkflowCheckUnavailable,
            force: args.force,
            runCap
          });
          sharedWorkflowCheckUnavailable = pageOutcome.workflowCheckUnavailable;
          streamOutcome.new += pageOutcome.new;
          streamOutcome.mailed += pageOutcome.mailed;
          streamOutcome.dryRunPrepared += pageOutcome.dryRunPrepared;
          streamOutcome.skippedAlreadySent += pageOutcome.skippedAlreadySent;
          streamOutcome.skippedAutoApprove += pageOutcome.skippedAutoApprove;
          streamOutcome.skippedNoApprover += pageOutcome.skippedNoApprover;
          streamOutcome.failed += pageOutcome.failed;
          streamOutcome.purchaseOrders.push(...pageOutcome.purchaseOrders);
          console.log(
            `[PoMailService] run ${runId}: page ${pageNum} processed (${pageRows.length} rows, ` +
            `${streamOutcome.mailed} mailed so far, ${streamOutcome.skippedAlreadySent} skipped).`
          );
          // Stop pagination when the PO cap is hit OR when the workflow
          // checkpoint DB is unavailable. In the unavailable case _mailFromRows
          // skips every PO (returning before the cap loop), so runCap.capped
          // stays false — without this check the scan reads ALL pages every
          // tick, streaming the full window into memory and OOMing the instance
          // (exit 137). Returning true stops the scan; the watermark is held
          // in run() so every PO is retried on the next tick when DB access
          // returns.
          return runCap.capped || sharedWorkflowCheckUnavailable;
        }
      });
      result.degraded = Boolean(fetched.degraded) || sharedWorkflowCheckUnavailable;
      result.truncated = Boolean(fetched.truncated);
      result.read = totalRowsRead;
      if (!totalRowsRead) {
        result.message = fetched.truncated
          ? 'Read window truncated before any row was read — watermark held, retrying next tick.'
          : 'No purchase order found for the selected range.';
        result.finishedAt = new Date().toISOString();
        if (!fetched.truncated) this.repository.setLastRunWatermark(startedAt);
        return result;
      }
    }

    const fullOutcome = streamOutcome;
    result.new += fullOutcome.new;
    result.mailed += fullOutcome.mailed;
    result.dryRunPrepared += fullOutcome.dryRunPrepared;
    result.skippedAlreadySent += fullOutcome.skippedAlreadySent;
    result.skippedAutoApprove += fullOutcome.skippedAutoApprove;
    result.skippedNoApprover += fullOutcome.skippedNoApprover;
    result.failed += fullOutcome.failed;
    result.purchaseOrders.push(...fullOutcome.purchaseOrders);

    result.finishedAt = new Date().toISOString();
    if (!dryRun) {
      // Hold the watermark when the scan was truncated OR when the workflow
      // checkpoint DB was unavailable (POs were skipped, not mailed). Holding
      // makes the next tick re-read the same window so the skipped POs are
      // retried once DB access is restored — nothing is lost.
      if (result.truncated || runCap.capped || sharedWorkflowCheckUnavailable) {
        console.warn(
          `[PoMailService] run ${runId}: watermark HELD — ` +
          (result.truncated
            ? 'the CreationDate window was not fully read'
            : runCap.capped
              ? `PO cap reached (${runCap.max} processed, POs remain)`
              : 'workflow checkpoint DB was unavailable, POs skipped') +
          '; unread/skipped POs are retried on the next tick (no PO will be skipped).'
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
   * Normalise, de-duplicate and mail a set of S/4 rows. Shared by the fast
   * page-1 trigger and the full scan so dedup state carries across both passes.
   *
   * The `alreadySent` / `workflowTracked` Sets and the
   * `workflowCheckUnavailable` flag are passed in and mutated, so a PO mailed
   * by the fast pass is skipped by the full scan (and vice versa).
   *
   * @returns {Promise<{new, mailed, dryRunPrepared, skippedAlreadySent,
   *   skippedAutoApprove, skippedNoApprover, failed, purchaseOrders,
   *   workflowCheckUnavailable}>}
   */
  async _mailFromRows({
    rows, routing, smtpConfig, runId, actor, dryRun, startedAt,
    alreadySent, workflowTracked, workflowCheckUnavailable, force, runCap
  }) {
    const outcome = {
      new: 0,
      mailed: 0,
      dryRunPrepared: 0,
      skippedAlreadySent: 0,
      skippedAutoApprove: 0,
      skippedNoApprover: 0,
      failed: 0,
      purchaseOrders: [],
      workflowCheckUnavailable,
      capped: false,
      remaining: 0
    };

    const purchaseOrders = this._groupAndNormalize(rows || []);

    // De-duplicate against the mail log and the existing S/4 workflow
    // checkpoint. The workflow table is also a persistent marker that the
    // initial notification was sent, so a restart does not re-mail a recent
    // multi-level PO when the optional mail-log entity is not deployed.
    if (!force) {
      const fresh = await this.repository.filterAlreadySent(
        purchaseOrders.map((po) => ({ poNumber: po.poNumber, companyCode: po.companyCode }))
      );
      for (const key of fresh) alreadySent.add(key);

      // Batch checkpoint lookup: one IN query for all POs in this batch
      // instead of a per-PO get() loop (which caused thousands of DB
      // round-trips per scan and exhausted the connection pool).
      try {
        const tracked = await this.workflowProgress.getMany(
          purchaseOrders.map((po) => ({ poNumber: po.poNumber, companyCode: po.companyCode }))
        );
        for (const po of purchaseOrders) {
          const key = `${po.companyCode}|${po.poNumber}`;
          if (!po.poNumber || alreadySent.has(key)) continue;
          if (tracked.has(key)) workflowTracked.add(key);
        }
      } catch (error) {
        console.warn(
          `[PoMailService] Persistent PO-mail duplicate check unavailable: ${error.message}`
        );
        workflowCheckUnavailable = true;
        outcome.workflowCheckUnavailable = true;
      }
    }

    // DB unavailable — SKIP this entire batch. The old behaviour was to keep
    // attempting every PO ("sending without persistent duplicate protection"),
    // but each attempt does a 3-retry DB write that fails, the PO is not
    // marked tracked, and the same PO is re-tried on EVERY subsequent page.
    // With ~2K POs × ~20 pages that is tens of thousands of failing DB
    // writes + log lines per scan, exhausting memory and crashing the instance
    // (exit 137) in a restart → full-walk → crash loop. Skipping is safe: no
    // mail is sent, so no duplicate is possible, and the watermark is held in
    // run() so every PO is retried on the next tick when DB access returns.
    if (workflowCheckUnavailable && !dryRun && !force) {
      console.warn(
        `[PoMailService] run ${runId}: workflow checkpoint DB unavailable — ` +
        `skipping ${purchaseOrders.length} PO(s) this tick to avoid a DB retry storm; ` +
        'will retry on the next tick when DB access is restored (watermark held).'
      );
      return outcome;
    }

    const pending = purchaseOrders.filter((po) => {
      if (!po.poNumber) return false;
      const key = `${po.companyCode}|${po.poNumber}`;
      if (alreadySent.has(key) || workflowTracked.has(key)) {
        outcome.skippedAlreadySent += 1;
        if (workflowTracked.has(key)) {
          console.log(`[PoMailService] PO ${po.poNumber}: existing workflow checkpoint; skipping duplicate initial mail.`);
        }
        return false;
      }
      return true;
    });
    outcome.new = pending.length;

    // Bound the work PER RUN (not per page): process at most runCap.max POs
    // across the fast trigger AND every scan page combined. Each PO costs a
    // secondary S/4 remarks API call, a full mail HTML build (up to 999 line
    // items), a send, and 3 DB writes. Processing thousands of POs in ONE run
    // piles up memory and DB load until the instance is OOM-killed (exit 137).
    // runCap is shared across the fast pass and all pages, so the cap is global
    // to this run. When the cap is hit the watermark is held in run() so the
    // next tick processes the next batch — catch-up is resumable, nothing is
    // skipped, and memory stays bounded to one small batch.
    const cap = runCap || { processed: 0, max: this._maxPoPerRun(), capped: false };
    const toProcess = [];
    for (const po of pending) {
      if (cap.processed >= cap.max) { cap.capped = true; break; }
      cap.processed += 1;
      toProcess.push(po);
    }
    outcome.remaining = Math.max(0, pending.length - toProcess.length);
    outcome.capped = cap.capped;
    if (outcome.capped) {
      console.log(
        `[PoMailService] run ${runId}: capped at ${cap.max} PO(s) this tick; ` +
        `${outcome.remaining} PO(s) remain and will be processed on the next tick (watermark held).`
      );
    }

    // Route + mail each pending PO. Failures are collected, never thrown.
    for (const po of toProcess) {
      const res = await this._processOne({ po, routing, smtpConfig, runId, actor, dryRun, startedAt });
      outcome.purchaseOrders.push(res.entry);
      if (res.status === 'SENT') outcome.mailed += 1;
      else if (res.status === 'DRY_RUN') outcome.dryRunPrepared += 1;
      else if (res.status === 'AUTO_APPROVED') outcome.skippedAutoApprove += 1;
      else if (res.status === 'NO_APPROVER' || res.status === 'NO_RULE') outcome.skippedNoApprover += 1;
      else outcome.failed += 1;
    }

    return outcome;
  }

  /** Max POs to process (mail + log + checkpoint) in a single run. */
  _maxPoPerRun() {
    const n = Number(process.env.PO_MAIL_MAX_PO_PER_RUN);
    return Number.isFinite(n) && n > 0 ? n : 50;
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

  /**
   * Run ONLY the S/4 workflow poll — check approval progress for all active
   * POs and send next-level/completion/rejection mails. Called independently
   * by the scheduler on its own timer, so it never waits for the scan to
   * finish. This is what makes next-level mails trigger within ~1-2 minutes
   * after an approver acts in S/4, instead of waiting for the full scan.
   */
  async pollS4WorkflowProgress() {
    const smtpConfig = await this.sender.config();
    const routing = this.Routing.fromConfig(smtpConfig);
    await this._pollS4WorkflowProgress({ routing, smtpConfig });
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

    // ── Atomically claim the Level 1 mail BEFORE sending ──────────────
    // The checkpoint row is created with TRACKING_STATUS='SENDING'. Only the
    // caller that wins this compare-and-set may send; if the row already
    // exists another run already claimed (and sent) the creation mail. This
    // closes the send-then-checkpoint gap that caused duplicate Level 1 mails.
    const claimed = await this._claimInitialWorkflow({ po, rule, routing });
    if (!claimed) {
      base.status = 'SKIPPED_DUPLICATE';
      console.log(
        `[PoMailService] PO ${po.poNumber}: workflow checkpoint already claimed for the initial mail; skipping duplicate.`
      );
      await this._log({ base, po, actor, runId, dryRun });
      return { status: base.status, entry: base };
    }

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

    // Finalize or release the atomic claim based on the send result.
    // SENT → persist the checkpoint as ACTIVE/COMPLETE so the next scan and
    //   poll see it as tracked.
    // FAILED → delete the claimed row so the next scan retries the mail.
    if (base.status === 'SENT') {
      await this._finalizeInitialWorkflow({ po, rule, routing });
    } else if (base.status === 'FAILED') {
      await this._releaseInitialWorkflow({ po, rule, routing });
    }

    await this._log({ base, po, actor, runId, dryRun });
    return { status: base.status, entry: base };
  }

  /**
   * Atomically claim the Level 1 (creation) mail for a PO.
   *
   * Calls `workflowProgress.claimInitial()` which INSERTs a checkpoint row
   * with TRACKING_STATUS='SENDING'. Returns true when this caller won the
   * claim (proceed to send); false when the row already exists (another run
   * already claimed it — skip to prevent a duplicate).
   *
   * On any DB error the claim is treated as lost (skip): no mail is sent,
   * which is safe because the 2-day rolling window keeps the PO in the next
   * scan's page-1 results, so the mail will be retried automatically.
   */
  async _claimInitialWorkflow({ po, rule, routing }) {
    const chain = routing.approvalChain(rule) || [];
    if (!chain.length) return true; // no approval chain → no checkpoint needed

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
      return await this.workflowProgress.claimInitial({
        poNumber: po.poNumber,
        companyCode: po.companyCode,
        documentType: po.documentType,
        ruleId: rule.ruleId,
        completedTasks,
        maxLevel: chain.length
      });
    } catch (error) {
      console.error(
        `[PoMailService] Could not claim initial workflow tracking for PO ${po.poNumber}: ${error.message}; ` +
        'skipping send to avoid a possible duplicate (will retry on the next scan).'
      );
      return false;
    }
  }

  /**
   * Finalize a successful Level 1 send: move the checkpoint from SENDING to
   * ACTIVE (multi-level) or COMPLETE (one-level).
   */
  async _finalizeInitialWorkflow({ po, rule, routing }) {
    const chain = routing.approvalChain(rule) || [];
    if (!chain.length) return;
    const trackingStatus = chain.length >= 2 ? 'ACTIVE' : 'COMPLETE';
    const hasCounter = po.workflowCompletedDialogTasks !== null
      && po.workflowCompletedDialogTasks !== undefined
      && po.workflowCompletedDialogTasks !== ''
      && Number.isFinite(Number(po.workflowCompletedDialogTasks));
    const completedTasks = hasCounter ? Number(po.workflowCompletedDialogTasks) : 0;
    try {
      await this.workflowProgress.finalize({
        poNumber: po.poNumber,
        companyCode: po.companyCode,
        targetTasks: completedTasks,
        trackingStatus
      });
    } catch (error) {
      console.error(
        `[PoMailService] Could not finalize workflow tracking for PO ${po.poNumber}: ${error.message}. ` +
        'The checkpoint row remains in SENDING and will be recovered at startup.'
      );
    }
  }

  /**
   * Release a failed Level 1 claim: delete the row so the next scan retries
   * the creation mail. No duplicate is possible because the SENDING marker
   * blocked other callers during the attempt.
   */
  async _releaseInitialWorkflow({ po }) {
    try {
      await this.workflowProgress.releaseInitial({
        poNumber: po.poNumber,
        companyCode: po.companyCode
      });
    } catch (error) {
      console.error(
        `[PoMailService] Could not release initial workflow claim for PO ${po.poNumber}: ${error.message}. ` +
        'The checkpoint row will be recovered at startup.'
      );
    }
  }

  /**
   * Finalize a claim after a successful mail send, with clear error handling.
   *
   * If finalize() fails (e.g. DB disconnected after retries), the mail was
   * already sent but the checkpoint didn't advance. The row stays in SENDING,
   * which blocks duplicate re-sends. This is logged clearly so the user knows
   * a manual intervention (forceResetSending) is needed if the mail was NOT
   * actually delivered.
   */
  async _safeFinalize({ poNumber, companyCode, targetTasks, trackingStatus, mailDesc }) {
    try {
      await this.workflowProgress.finalize({
        poNumber, companyCode, targetTasks, trackingStatus
      });
    } catch (error) {
      console.error(
        `[PoMailService] CRITICAL: ${mailDesc} for PO ${poNumber} was sent, but the checkpoint ` +
        `could not be advanced after ${3} retries: ${error.message}. ` +
        'The row is stuck in SENDING to block duplicate sends. ' +
        'If the mail was NOT delivered, use forceResetSending to release the claim for retry.'
      );
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
    if (!states || !states.length) return;

    // ── BATCH READ: fetch all active POs' workflow data in ONE S/4 call ──
    // Previously the loop called getPurchaseOrders once per PO (N+1 calls),
    // which added minutes when hundreds of POs were in workflow. Now we
    // collect all PO numbers and make a single $filter request (eq/or chain —
    // the service rejects the `in` operator).
    const poNumbers = states
      .map((s) => String(s.PO_NUMBER || '').trim())
      .filter(Boolean);
    if (!poNumbers.length) return;

    console.log(`[PoMailService] S/4 workflow poll: ${poNumbers.length} active PO(s) — batch-reading.`);

    let batchRows;
    try {
      batchRows = await this.client.getPurchaseOrdersBatch(poNumbers);
    } catch (error) {
      console.error(`[PoMailService] S/4 batch read failed: ${error.message}`);
      return;
    }

    const rowMap = new Map();
    for (const grouped of batchRows || []) {
      const poNum = String(grouped?.PurchaseOrder || '');
      if (!poNum) continue;
      const row = (grouped.rows || []).find((entry) =>
        Mapper.HEADER.completedWorkflowDialogTasks(entry) !== null
        || Mapper.HEADER.purchasingProcessingStatus(entry)
      ) || (grouped.rows || [])[0];
      if (row) rowMap.set(poNum, row);
    }

    let statusMap = new Map();
    if (typeof this.client.getPurchaseOrdersProcessingStatusBatch === 'function') {
      try {
        statusMap = await this.client.getPurchaseOrdersProcessingStatusBatch(poNumbers);
      } catch (error) {
        console.warn(
          `[PoMailService] Batch processing-status read failed: ${error.message}. ` +
          'Falling back to per-PO reads for this poll.'
        );
      }
    }

    for (const state of states) {
      const poNumber = String(state.PO_NUMBER || '');
      const companyCode = String(state.COMPANY_CODE || '');
      const row = rowMap.get(poNumber);
      if (!row) continue;

      try {
      let statusRow = row;
      let status = '';
      if (typeof this.client.getPurchaseOrdersProcessingStatusBatch === 'function') {
        status = statusMap.get(poNumber) || '';
        if (status) {
          statusRow = { ...row, [Constants.PROCESSING_STATUS_FIELD]: status };
        } else {
          console.warn(`[PoMailService] Standard PO API returned no processing status for PO ${poNumber}.`);
        }
      } else {
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
          // Atomically claim the rejection notice before sending.
          const rejectionClaim = await this.workflowProgress.claim({
            poNumber, companyCode, expectedTasks: lastCompletedTasks
          });
          if (!rejectionClaim) {
            console.log(
              `[PoMailService] PO ${poNumber}: rejection notice already claimed by another poll; skipping duplicate.`
            );
            continue;
          }
          const rejection = await this._sendRejectionMail({
            poNumber, companyCode, documentType, rule, chain, rejectedLevel, smtpConfig
          });
          if (!rejection.ok) {
            console.error(`[PoMailService] Rejection notice for PO ${poNumber} failed: ${rejection.error}`);
            await this.workflowProgress.release({
              poNumber, companyCode, expectedTasks: lastCompletedTasks
            });
            continue; // Release claim so the next poll retries delivery.
          }
          await this._safeFinalize({
            poNumber,
            companyCode,
            targetTasks: completedTasks === null ? lastCompletedTasks : completedTasks,
            trackingStatus: 'REJECTED',
            mailDesc: 'Rejection notice'
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
            // Atomically claim the completion notice before sending.
            const completionClaim = await this.workflowProgress.claim({
              poNumber, companyCode, expectedTasks: observedCompleted
            });
            if (!completionClaim) {
              console.log(
                `[PoMailService] PO ${poNumber}: completion notice already claimed by another poll; skipping duplicate.`
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
              await this.workflowProgress.release({
                poNumber, companyCode, expectedTasks: observedCompleted
              });
              retryThisPo = true;
              break; // Release claim so the next poll retries; checkpoint stays at previous value.
            }

            await this._safeFinalize({
              poNumber,
              companyCode,
              targetTasks: completedTasks,
              trackingStatus: 'COMPLETE',
              mailDesc: 'Completion notice'
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

          // Atomically claim this level's mail before sending.
          const levelClaim = await this.workflowProgress.claim({
            poNumber, companyCode, expectedTasks: observedCompleted
          });
          if (!levelClaim) {
            console.log(
              `[PoMailService] PO ${poNumber}: Level ${nextLevel} notification already claimed by another poll; skipping duplicate.`
            );
            break;
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
            await this.workflowProgress.release({
              poNumber, companyCode, expectedTasks: observedCompleted
            });
            retryThisPo = true;
            break; // Release claim so the next poll retries this stage.
          }

          await this._safeFinalize({
            poNumber,
            companyCode,
            targetTasks: observedCompleted,
            trackingStatus: 'ACTIVE',
            mailDesc: `Level ${nextLevel} notice`
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