'use strict';

const StatusCodeUtil = require('../../shared/utils/StatusCodeUtil');
const Constants = require('../constants/PoConstants');
const S4PoClient = require('../services/S4PoClient');
const PoMailSender = require('../services/PoMailSender');
const PoApprovalRouting = require('../services/PoApprovalRouting');
const PoMailService = require('../services/PoMailService');
const PoMailLogRepository = require('../repositories/PoMailLogRepository');
const { daysAgoStart, formatRunStamp } = require('../utils/PoDateUtil');

function parseMaybeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Payload is neither a JSON object nor valid JSON text: ${error.message}`);
  }
}

function toActionResult(result) {
  return {
    runId: result.runId,
    read: result.read,
    new: result.new,
    mailed: result.mailed,
    dryRunPrepared: result.dryRunPrepared || 0,
    skippedAlreadySent: result.skippedAlreadySent,
    skippedNoApprover: result.skippedNoApprover,
    skippedAutoApprove: result.skippedAutoApprove,
    failed: result.failed,
    dryRun: Boolean(result.dryRun),
    degraded: Boolean(result.degraded),
    rangeFrom: result.range?.from || result.range?.purchaseOrder || '',
    rangeTo: result.range?.to || '',
    routingRules: result.routing?.rules || 0,
    purchaseOrders: (result.purchaseOrders || []).map((entry) => ({
      poNumber: entry.poNumber || '',
      companyCode: entry.companyCode || '',
      documentType: entry.documentType || '',
      supplierName: entry.supplier || '',
      currency: entry.currency || '',
      netPoValue: entry.netPoValue || '',
      ruleId: entry.ruleId || '',
      approvalLevel: Number(entry.approvalLevel || Constants.TRIGGER_APPROVAL_LEVEL),
      recipients: (entry.recipients || []).join(', '),
      status: entry.status || '',
      messageId: entry.messageId || '',
      error: entry.error || ''
    })),
    message: result.message || ''
  };
}

module.exports = async function poMailNotificationHandler() {
  await StatusCodeUtil.ensureStatusTable();

  const service = new PoMailService({
    client: new S4PoClient(),
    sender: new PoMailSender(),
    repository: new PoMailLogRepository(),
    Routing: PoApprovalRouting
  });

  this.on('triggerPoMailNotification', async (req) => {
    const actor = req?.user?.id || req?.user?.attr?.user_name || Constants.SYSTEM_USER;
    try {
      const result = await service.run({
        purchaseOrder: req.data?.purchaseOrder || '',
        companyCode: req.data?.companyCode || '',
        documentType: req.data?.documentType || '',
        lookbackDays: Number(req.data?.lookbackDays || Constants.DEFAULT_LOOKBACK_DAYS),
        fromDate: req.data?.fromDate ? new Date(req.data.fromDate) : null,
        toDate: req.data?.toDate ? new Date(req.data.toDate) : null,
        dryRun: req.data?.dryRun === true || req.data?.dryRun === 'true',
        force: req.data?.force === true || req.data?.force === 'true',
        actor
      });
      return toActionResult(result);
    } catch (error) {
      console.error(`[PoMailNotificationService] trigger failed: ${error.message}`);
      return req.error(500, error.message);
    }
  });

  this.on('sendPoCreationMail', async (req) => {
    const actor = req?.user?.id || Constants.SYSTEM_USER;
    try {
      const entry = await service.sendForPurchaseOrder({
        purchaseOrder: parseMaybeJson(req.data?.purchaseOrder, {}),
        items: parseMaybeJson(req.data?.items, []),
        companyCode: req.data?.companyCode || '',
        documentType: req.data?.documentType || '',
        dryRun: req.data?.dryRun === true,
        actor
      });
      return {
        runId: entry.runId,
        read: 1,
        new: 1,
        mailed: entry.status === 'SENT' ? 1 : 0,
        dryRunPrepared: entry.status === 'DRY_RUN' ? 1 : 0,
        skippedAlreadySent: 0,
        skippedNoApprover: entry.status === 'NO_APPROVER' || entry.status === 'NO_RULE' ? 1 : 0,
        skippedAutoApprove: entry.status === 'AUTO_APPROVED' ? 1 : 0,
        failed: entry.status === 'FAILED' ? 1 : 0,
        dryRun: Boolean(entry.dryRun),
        degraded: false,
        rangeFrom: entry.poNumber || '',
        rangeTo: '',
        routingRules: 0,
        purchaseOrders: toActionResult({ purchaseOrders: [entry] }).purchaseOrders,
        message: `PO ${entry.poNumber || ''}: ${entry.status}${entry.error ? ` — ${entry.error}` : ''}`
      };
    } catch (error) {
      console.error(`[PoMailNotificationService] sendPoCreationMail failed: ${error.message}`);
      return req.error(500, error.message);
    }
  });

  this.on('confirmPoApprovalDecision', (req) =>
    req.error(410, 'Approval must be completed in SAP S/4HANA My Inbox. Email-based approval is disabled.')
  );

  this.on('getPoApprovalRouting', async (req) => {
    try {
      const info = await service.describeRouting();
      return {
        mailDestination: info.mailDestination || '',
        smtpHost: info.smtp?.host || '',
        smtpPort: Number(info.smtp?.port || 0),
        smtpUser: info.smtp?.user || '',
        mailFrom: info.smtp?.from || '',
        schemaVersion: info.routing?.schemaVersion || '',
        onAmbiguousMatch: info.routing?.onAmbiguousMatch || '',
        rules: (info.routing?.rules || []).map((rule) => ({
          ruleId: rule.ruleId,
          ruleKey: rule.key,
          companyCodes: (rule.companyCodes || []).join(','),
          documentTypes: (rule.documentTypes || []).join(','),
          action: rule.action,
          levels: Object.keys(rule.approvalLevels || {}).sort().join(',')
        })),
        parseErrors: (info.routing?.parseErrors || []).map((entry) => entry.message).join(' | '),
        logMode: info.log?.mode || '',
        logEntity: info.log?.entity || '',
        lastRunWatermark: info.log?.lastRunWatermark || '',
        generatedOn: formatRunStamp(new Date(), Constants.TIME_ZONE),
        defaultLookbackFrom: daysAgoStart(Constants.DEFAULT_LOOKBACK_DAYS, Constants.TIME_ZONE).toISOString(),
        autoRun: require('../services/PoAutoScheduler').describe()
      };
    } catch (error) {
      console.error(`[PoMailNotificationService] getPoApprovalRouting failed: ${error.message}`);
      return req.error(500, error.message);
    }
  });

  require('../services/PoAutoScheduler').attach(this);
};