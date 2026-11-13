'use strict';

/**
 * PO mail notification — configuration.
 *
 * Nothing is hardcoded: every value can be overridden by an environment
 * variable (same approach as reversal/constants/ReversalConstants.js), so the
 * same code runs on DEV / QAS / PROD destinations without a change.
 */

const path = require('path');

module.exports = Object.freeze({

  /* ── Destinations ───────────────────────────────────────────────────── */

  /** MAIL destination that carries SMTP creds + the mail.po.approval.rule.* JSON. */
  SMTP_DESTINATION: process.env.PO_MAIL_SMTP_DESTINATION || 'SMTP_MOBI_PO_DEV',

  /** S/4HANA destination used to read the PO CDS view over OData. */
  S4_DESTINATION: process.env.PO_MAIL_S4_DESTINATION || 'S4HANA_MOBI',

  /* ── PO CDS view (OData service) ────────────────────────────────────── */

  /**
   * Relative OData path of the PO CDS view on the S4HANA_MOBI destination.
   *
   *   view    : YY1_PO_EMAIL      (service YY1_PO_EMAIL_CDS)
   *   full URL: https://my436974-api.s4hana.cloud.sap
   *               /sap/opu/odata/sap/YY1_PO_EMAIL_CDS/YY1_PO_EMAIL
   *
   * The host part is deliberately NOT here: it comes from the destination's URL
   * property, exactly like reversal/services/S4ReversalClient.js does, so the
   * same code runs against DEV / QAS / PROD systems.
   */
  ENTITY_PATH: process.env.PO_MAIL_ENTITY_PATH || '/sap/opu/odata/sap/YY1_PO_EMAIL_CDS/YY1_PO_EMAIL',

  /** Standard S/4 OData V4 PO header endpoint (includes PurchasingProcessingStatus). */
  PURCHASE_ORDER_API_PATH: process.env.PO_MAIL_API_PATH ||
    '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/PurchaseOrder',

  /** S/4HANA OData V4 endpoint returning PO header notes (Remarks). */
  PURCHASE_ORDER_NOTE_PATH: process.env.PO_MAIL_NOTE_PATH ||
    '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/PurchaseOrderNote',

  /** Header-text ID and language identifying the Remarks note row. */
  PURCHASE_ORDER_NOTE_TEXT_TYPE: process.env.PO_MAIL_NOTE_TEXT_TYPE || 'F01',
  PURCHASE_ORDER_NOTE_LANGUAGE: process.env.PO_MAIL_NOTE_LANGUAGE || 'EN',

  /**
   * Item navigation for $expand. Empty = AUTO: the client reads the service
   * $metadata once, caches every NavigationProperty of the PO entity type and
   * expands it. Set explicitly (e.g. 'to_Item') to skip that round trip.
   */
  ITEM_PATH: process.env.PO_MAIL_ITEM_PATH || '',

  /** 'V2' | 'V4' — controls literal style ($filter) and pagination handling. */
  ODATA_VERSION: process.env.PO_MAIL_ODATA_VERSION || 'V2',

  /**
   * Header property used to select "new" POs (CreationDate in standard
   * S/4HANA PO CDS views). Must be a date/time property in your CDS view.
   */
  CREATED_ON_FIELD: process.env.PO_MAIL_CREATED_ON_FIELD || 'CreationDate',

  /** Property carrying the PO number on the item rows (for grouping). */
  ITEM_PO_KEY_FIELD: process.env.PO_MAIL_ITEM_PO_KEY_FIELD || 'PurchaseOrder',

  /** Creator email property exposed by the configured PO CDS view (no email is hardcoded). */
  CREATOR_EMAIL_FIELD: process.env.PO_MAIL_CREATOR_EMAIL_FIELD || 'CreatedByUserEmail',

  /**
   * S/4 PO processing-status property exposed by the configured PO CDS view.
   * Standard S/4 API_PURCHASEORDER_2 uses PurchasingProcessingStatus (08 = rejected).
   */
  PROCESSING_STATUS_FIELD: process.env.PO_MAIL_PROCESSING_STATUS_FIELD || 'PurchasingProcessingStatus',
  REJECTED_STATUS_VALUES: (process.env.PO_MAIL_REJECTED_STATUS_VALUES || '08,REJECTED,REJECT')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
  ACTIVE_WORKFLOW_STATUS_VALUES: (process.env.PO_MAIL_ACTIVE_WORKFLOW_STATUS_VALUES || '03,IN RELEASE,IN_RELEASE,IN APPROVAL,IN_APPROVAL')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),
  FINAL_APPROVED_STATUS_VALUES: (process.env.PO_MAIL_FINAL_APPROVED_STATUS_VALUES || '05,APPROVED,RELEASE COMPLETED,RELEASE_COMPLETED,COMPLETED')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean),

  /** Rows per page. */
  PAGE_SIZE: Number(process.env.PO_MAIL_PAGE_SIZE || 100),

  /** Safety cap so a bad filter can never pull the whole PO table. */
  MAX_PAGES: Number(process.env.PO_MAIL_MAX_PAGES || 20),

  /** Fallback window when the action is called without an explicit range. */
  DEFAULT_LOOKBACK_DAYS: Number(process.env.PO_MAIL_LOOKBACK_DAYS || 1),

  /* ── Approval routing ───────────────────────────────────────────────── */

  /** Prefix of the routing rule properties on the MAIL destination. */
  RULE_PREFIX: 'mail.po.approval.rule.',
  SCHEMA_VERSION_KEY: 'mail.po.approval.routing.schemaVersion',
  AMBIGUOUS_KEY: 'mail.po.approval.routing.onAmbiguousMatch',

  /** Only these approvers are mailed on creation (levels 2..n follow later). */
  TRIGGER_APPROVAL_LEVEL: Number(process.env.PO_MAIL_APPROVAL_LEVEL || 1),

  /** Documents whose rule says AUTO_APPROVE never raise an approval mail. */
  AUTO_APPROVE_ACTION: 'AUTO_APPROVE',

  /* ── Mail ───────────────────────────────────────────────────────────── */

  MAIL_FROM_NAME: process.env.PO_MAIL_FROM_NAME || 'MOBI Purchase Order',
  SUBJECT_PREFIX: process.env.PO_MAIL_SUBJECT_PREFIX || '',

  /**
   * Clickable S/4HANA launchpad link rendered as a button in every PO mail.
   * Override per environment (QAS / PROD) with PO_S4_LAUNCHPAD_URL — the
   * template never hardcodes the URL, so a new tenant needs only an env var.
   */
  S4_LAUNCHPAD_URL: String(process.env.PO_S4_LAUNCHPAD_URL ||
    'https://my436974.s4hana.cloud.sap/ui#Shell-home').trim(),

  /**
   * Logo folder. Drop mobi-logo.png (or .jpg / .jpeg) in here - see README.
   *
   * Resolved from __dirname, NOT from process.cwd(): the working directory on
   * Cloud Foundry is not guaranteed to be the project root, and a cwd-relative
   * path would silently fall back to the text banner after every deploy.
   * Same convention as srv/master-upload-service.js in this repository.
   *
   * PO_MAIL_LOGO_DIR still wins when set (absolute, or relative to cwd).
   */
  LOGO_DIR: process.env.PO_MAIL_LOGO_DIR || path.resolve(__dirname, '..', 'resources'),
  LOGO_FILE_BASENAME: process.env.PO_MAIL_LOGO_FILE || 'mobi-logo',
  LOGO_SUPPORTED_EXTENSIONS: Object.freeze(['.png', '.jpg', '.jpeg']),
  LOGO_CID: 'mobiLogo',
  LOGO_WIDTH_PX: Number(process.env.PO_MAIL_LOGO_WIDTH || 160),

  /* ── Optional in-app auto run (no Job Scheduler required) ──────────── */

  /** In-app periodic trigger. OFF unless explicitly enabled. */
  AUTO_RUN_ENABLED: process.env.PO_MAIL_AUTO_RUN === 'true',
  AUTO_RUN_INTERVAL_MIN: Number(process.env.PO_MAIL_AUTO_INTERVAL_MIN || 5),
  AUTO_RUN_STARTUP_DELAY_SEC: Number(process.env.PO_MAIL_AUTO_STARTUP_DELAY_SEC || 30),
  AUTO_RUN_DRY_RUN: process.env.PO_MAIL_AUTO_DRY_RUN === 'true',

  /* ── Legacy CAP decision settings (not used by S/4 My Inbox flow) ───── */

  /** Retained for compatibility with legacy decision-link utilities. */
  PUBLIC_URL: (process.env.PO_MAIL_PUBLIC_URL || 'http://localhost:4004').replace(/\/$/, ''),
  DECISION_ROUTE: '/po-mail/decision',

  /** Registered Outlook Actionable Messages Originator ID (Microsoft portal). */
  ACTIONABLE_ORIGINATOR: process.env.PO_MAIL_ACTIONABLE_ORIGINATOR || '',
  /** Public service audience expected in Microsoft's signed action JWT. */
  ACTIONABLE_AUDIENCE: process.env.PO_MAIL_ACTIONABLE_AUDIENCE || '',
  /** Optional sender address to pin Microsoft's JWT sender claim. */
  ACTIONABLE_SENDER: process.env.PO_MAIL_ACTIONABLE_SENDER || '',
  ACTION_ROUTE: '/po-mail/decision/action',

  /**
   * HMAC secret that signs the decision links. When empty a random boot secret
   * is used (links then invalidate on every restart - fine for dev, NOT for
   * prod: set a fixed value there).
   */
  DECISION_TOKEN_SECRET: process.env.PO_MAIL_TOKEN_SECRET || '',
  DECISION_TOKEN_HOURS: Number(process.env.PO_MAIL_TOKEN_HOURS || 24),

  /** HANA entity that persists S/4 workflow notification progress (see db/). */
  S4_WORKFLOW_ENTITY: process.env.PO_MAIL_S4_WORKFLOW_ENTITY || 'mobi.db.MOBI_DB_PO_S4_WORKFLOW',

  /** Legacy CAP-side decision entity; unused by the S/4 My Inbox notification flow. */
  APPROVAL_ENTITY: process.env.PO_MAIL_APPROVAL_ENTITY || 'mobi.db.MOBI_DB_PO_MAIL_APPROVAL',

  /* ── Duplicate-send protection ──────────────────────────────────────── */

  /**
   * HANA entity that records every PO already mailed. Optional: when the
   * entity is not deployed the service falls back to a watermark + in-memory
   * guard and logs a warning (see repositories/PoMailLogRepository.js).
   */
  LOG_ENTITY: process.env.PO_MAIL_LOG_ENTITY || 'mobi.db.MOBI_DB_PO_MAIL_LOG',

  SYSTEM_USER: process.env.PO_MAIL_SYSTEM_USER || 'SYSTEM_PO_MAIL_NOTIFICATION',

  TIME_ZONE: process.env.PO_MAIL_TIME_ZONE || 'Asia/Calcutta'
});