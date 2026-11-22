using { mobi.db as db } from '../db/schema';

/**
 * PO mail notification service.
 *
 * Isolated feature: the implementation lives in /po-mail-notification, this
 * file only exposes the OData actions (same pattern as
 * srv/journal-entry-reversal.cds). No existing entity or service is changed.
 *
 *   triggerPoMailNotification -> "a PO was created in S/4HANA, mail the approvers"
 *   sendPoCreationMail        -> mail one PO from a payload the caller already has
 *   getPoApprovalRouting      -> debug: parsed mail.po.approval.rule.* + SMTP (no secrets)
 *
 * Note: action parameters are comma-separated (project convention, see
 * srv/domestic-settlement-consolidation.cds) and `key` is a CDS keyword, so the
 * destination property name of a routing rule is exposed as `ruleKey`.
 */

@path: 'po-mail-notification'
service PoMailNotificationService {

  // Read-only view of the shared audit entity, kept for parity with the other
  // MOBI services. No new table is introduced by this service.
  @readonly
  @restrict: [
    { grant: 'READ', to: 'Read' },
    { grant: 'READ', to: 'OperationsTrigger' },
    { grant: 'READ', to: 'Jobs' }
  ]
  entity PoMailAudit as projection on db.MOBI_DB_AUDIT;

  // Outcome of one purchase order inside a run.
  // status: SENT | DRY_RUN | AUTO_APPROVED | NO_APPROVER | NO_RULE | FAILED
  type PoMailEntry {
    poNumber      : String(20);
    companyCode   : String(4);
    documentType  : String(10);
    supplierName  : String(200);
    currency      : String(5);
    netPoValue    : String(40);
    ruleId        : String(20);
    approvalLevel : Integer;
    recipients    : String(1000);
    status        : String(20);
    messageId     : String(200);
    error         : String(500);
  }

  type PoMailRunResult {
    runId               : String(36);
    read                : Integer;
    new                 : Integer;
    mailed              : Integer;
    dryRunPrepared      : Integer;
    skippedAlreadySent  : Integer;
    skippedNoApprover   : Integer;
    skippedAutoApprove  : Integer;
    failed              : Integer;
    dryRun              : Boolean;
    degraded            : Boolean;
    rangeFrom           : String(40);
    rangeTo             : String(40);
    routingRules        : Integer;
    purchaseOrders      : array of PoMailEntry;
    message             : String(500);
  }

  // action: SEQUENTIAL_APPROVAL | AUTO_APPROVE
  type PoRoutingRule {
    ruleId        : String(20);
    ruleKey       : String(60);
    companyCodes  : String(200);
    documentTypes : String(200);
    action        : String(30);
    levels        : String(40);
  }

  type PoRoutingInfo {
    mailDestination     : String(200);
    smtpHost            : String(200);
    smtpPort            : Integer;
    smtpUser            : String(200);
    mailFrom            : String(200);
    schemaVersion       : String(10);
    onAmbiguousMatch    : String(20);
    rules               : array of PoRoutingRule;
    parseErrors         : String(1000);
    logMode             : String(20);
    logEntity           : String(100);
    lastRunWatermark    : String(40);
    generatedOn         : String(60);
    defaultLookbackFrom : String(40);
    autoRun             : String(300);
  }

  /**
   * Sends the PO creation mail to the Level 1 approvers resolved from
   * CompanyCode + DocumentType via mail.po.approval.rule.* on the destination.
   * Every parameter is optional - POST {} processes the default window.
   *
   *   purchaseOrder : single PO number, skips the date range
   *   companyCode   : optional S/4HANA-side filter
   *   documentType  : optional S/4HANA-side filter
   *   lookbackDays  : window when no fromDate is given (default 1)
   *   fromDate      : created-on lower bound (inclusive)
   *   toDate        : created-on upper bound (exclusive)
   *   dryRun        : resolve approvers + build the mail, send nothing, log nothing
   *   force         : ignore the "already mailed" log and send again
   */
  action triggerPoMailNotification(
    purchaseOrder : String(20),
    companyCode   : String(4),
    documentType  : String(10),
    lookbackDays  : Integer,
    fromDate      : Timestamp,
    toDate        : Timestamp,
    dryRun        : Boolean,
    force         : Boolean
  ) returns PoMailRunResult;

  /**
   * Checks approval progress for all active POs and sends next-level /
   * completion / rejection mails. Called independently by PoAutoScheduler
   * on its own timer (every PO_MAIL_POLL_INTERVAL_MIN min, default 1 min),
   * so next-level mails trigger within ~1-2 minutes of an approver acting
   * in S/4, without waiting for the full scan to finish.
   */
  action pollS4WorkflowProgress() returns PoMailRunResult;

  /**
   * Mails ONE purchase order from a header payload the caller already holds -
   * the hook to use when the PO is created inside this CAP application.
   *
   *   purchaseOrder : raw S/4HANA / CDS header row, as a JSON object or JSON text
   *   items         : raw item rows, as a JSON array or JSON text
   *   companyCode   : optional override, otherwise taken from the payload
   *   documentType  : optional override, otherwise taken from the payload
   *   dryRun        : build only, send nothing
   */
  action sendPoCreationMail(
    purchaseOrder : LargeString,
    items         : LargeString,
    companyCode   : String(4),
    documentType  : String(10),
    dryRun        : Boolean
  ) returns PoMailRunResult;

  // Outcome of one Approve / Reject click.
  // status: APPROVED_FORWARDED | FULLY_APPROVED | REJECTED | ALREADY_DECIDED
  //       | NO_RULE | APPROVED_MAIL_FAILED | DRY_RUN | FAILED
  type PoDecisionResult {
    status      : String(30);
    poNumber    : String(20);
    companyCode : String(4);
    level       : Integer;
    action      : String(10);
    nextLevel   : Integer;
    mailedTo    : String(1000);
    decidedBy   : String(200);
    remarks     : String(1000);
    message     : String(500);
  }

  /** Applies a verified decision-link token (single use per level). */
  action confirmPoApprovalDecision(token : LargeString, remarks : String(1000)) returns PoDecisionResult;

  /** Debug helper: what the destination routing rules resolved to (no secrets). */
  action getPoApprovalRouting() returns PoRoutingInfo;
}