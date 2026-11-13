'use strict';
const assert = require('assert');
const { buildPoApprovalMail } = require('../services/PoMailTemplate');
const PoFieldMapper = require('../utils/PoFieldMapper');

const TEST_SUFFIX = `${process.pid}${Date.now().toString().slice(-6)}`.slice(-10);
const TEST_PO = `T${TEST_SUFFIX}`;
const TEST_GROUP_PO = `G${TEST_SUFFIX}`;
const TEST_FAIL_CLOSED_PO = `F${TEST_SUFFIX}`;

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'uuid') return { v4: () => 's4-inbox-test-run-id' };
  if (request === '@sap/cds') return { model: null, db: null, services: null };
  if (request === '@sap-cloud-sdk/connectivity') return { getDestination: async () => null };
  return originalLoad.call(this, request, parent, isMain);
};
const PoMailService = require('../services/PoMailService');
Module._load = originalLoad;

function buildPo(poNumber = TEST_PO) {
  return {
    poNumber,
    companyCode: '1000',
    documentType: 'ZSER',
    currency: 'INR',
    companyName: 'Example Company',
    companyAddress: 'Karnataka, IN',
    supplierCode: '1000234',
    supplierName: 'Example Supplier',
    supplierAddress: 'Tamil Nadu, IN',
    supplierTaxNumber: 'TAX-1',
    createdOn: '02.11.2026',
    createdBy: 'PO_USER',
    creatorEmail: 'creator@example.test',
    purchasingOrganization: '1000',
    purchasingGroup: 'P01',
    paymentTerms: 'Net 30',
    headerText: 'PO remarks',
    items: [],
    totals: {
      totalBasePrice: 'INR 1,000.00',
      totalTax: 'INR 180.00',
      totalAmount: 'INR 1,180.00',
      totalAmountInWords: 'Rupees One Thousand One Hundred Eighty Only'
    }
  };
}

async function main() {
  const chain = [
    { level: 1, recipients: ['level1@example.test'] },
    { level: 2, recipients: ['level2@example.test'] },
    { level: 3, recipients: ['level3@example.test'] }
  ];

  const mail = buildPoApprovalMail({
    po: buildPo(),
    to: chain[1].recipients,
    routing: { chain },
    triggerLevel: 2,
    decision: { approveToken: 'legacy-token', approveUrl: 'https://example.test/approve', rejectUrl: 'https://example.test/reject' },
    greeting: 'The S/4HANA workflow has advanced. Please review this PO in My Inbox.'
  });

  assert(!mail.html.includes('application/adaptivecard+json'), 'email does not embed an Outlook approval card');
  assert(!mail.html.includes('https://example.test/approve'), 'email does not include a direct Approve link');
  assert(!mail.html.includes('https://example.test/reject'), 'email does not include a direct Reject link');
  assert(mail.html.includes('SAP S/4HANA My Inbox'), 'email directs approval to S/4HANA My Inbox');
  assert(mail.html.includes('approval actions are not available in this email'), 'email states it is notification-only');
  assert(mail.html.includes('<b>Level 1</b>') && mail.html.includes('APPROVED'), 'approval-flow summary marks the prior level approved');
  assert(mail.html.includes('<b>Level 2</b>') && mail.html.includes('ACTION REQUIRED'), 'approval-flow summary marks the notified level action-required');
  assert(mail.subject.includes('Approval Required (Level 2)'), 'next-level email subject identifies the pending approval level');

  const completionMail = buildPoApprovalMail({
    po: buildPo(),
    to: ['creator@example.test'],
    routing: { chain },
    triggerLevel: 4,
    notificationType: 'COMPLETED',
    greeting: 'All configured approval levels are complete in S/4HANA My Inbox.'
  });
  assert(completionMail.subject.includes('Approved at All Levels'), 'completion subject states that all levels are approved');
  assert(completionMail.html.includes('has been approved at all levels'), 'completion email has a completion headline');
  assert(!completionMail.html.includes('ACTION REQUIRED'), 'completion email does not show an action-required level');
  assert((completionMail.html.match(/APPROVED/g) || []).length >= 3, 'completion summary marks all configured levels approved');

  const rejectionMail = buildPoApprovalMail({
    po: buildPo(),
    to: chain.slice(0, 2).flatMap((entry) => entry.recipients),
    routing: { chain: chain.slice(0, 2) },
    triggerLevel: 2,
    rejectedLevel: 2,
    notificationType: 'REJECTED'
  });
  assert(rejectionMail.subject.includes('Rejected'), 'rejection subject identifies the PO as rejected');
  assert(rejectionMail.html.includes('has been rejected'), 'rejection email clearly states the PO was rejected');
  assert(rejectionMail.html.includes('REJECTED'), 'rejection email identifies the rejecting level');
  assert(rejectionMail.html.includes('>PO Status</td>') && rejectionMail.html.includes('>REJECTED</span>'), 'PO Details explicitly show PO Status: REJECTED');
  assert(rejectionMail.html.includes('APPROVED'), 'rejection email marks earlier levels approved');
  assert(rejectionMail.html.includes('<b>Level 2</b>'), 'rejection email includes the rejecting level');
  assert(!rejectionMail.html.includes('<b>Level 3</b>'), 'rejection email omits unreached future levels');
  assert(rejectionMail.html.includes('SAP S/4HANA My Inbox'), 'rejection email identifies My Inbox as the decision source');
  assert(!rejectionMail.html.includes('Approved at All Levels'), 'rejection email is not mislabeled as approval completion');

  const poDetailsStart = mail.html.indexOf('>Purchase Order Details</span>');
  const companyDetailsStart = mail.html.indexOf('>Company Details</span>');
  assert(poDetailsStart >= 0 && companyDetailsStart > poDetailsStart, 'PO and Company Details sections are present');
  const poDetailsHtml = mail.html.slice(poDetailsStart, companyDetailsStart);
  const companyDetailsHtml = mail.html.slice(companyDetailsStart);
  assert(!poDetailsHtml.includes('>Company Code</td>'), 'Company Code is absent from Purchase Order Details');
  assert(companyDetailsHtml.includes('>Company Code</td>'), 'Company Code remains in Company Details');

  assert.equal(
    PoFieldMapper.HEADER.creatorEmail({ CreatedByUserEmail: 'creator@example.test' }),
    'creator@example.test',
    'PO mapper reads the configurable CreatedByUserEmail property'
  );

  const lifecycleRow = {
    PurchaseOrder: TEST_PO,
    CompanyCode: '1000',
    PurchaseOrderType: 'ZSER',
    CreatedByUser: 'TEST_S4_USER',
    Currency: 'INR'
  };
  let lifecycleSend = null;
  const lifecycleService = new PoMailService({
    client: { getPurchaseOrders: async () => ({ rows: [lifecycleRow] }) },
    sender: {
      logoAttachment: async () => ({ available: false }),
      send: async (message) => { lifecycleSend = message; return { sent: true, messageId: 'lifecycle-test' }; }
    },
    repository: {}, Routing: {}
  });
  const lifecycleArgs = {
    poNumber: TEST_PO, companyCode: '1000', documentType: 'ZSER',
    rule: { ruleId: 'TEST', action: 'SEQUENTIAL' }, chain, smtpConfig: { cc: ['unwanted@example.test'], bcc: ['also-unwanted@example.test'] }
  };
  for (const [level, expected] of [
    [1, ['level1@example.test']],
    [2, ['level1@example.test']],
    [3, ['level1@example.test', 'level2@example.test']]
  ]) {
    const rejectionResult = await lifecycleService._sendRejectionMail({ ...lifecycleArgs, rejectedLevel: level });
    assert(rejectionResult.ok, `Level ${level} configured-recipient rejection email sends without creator email (${rejectionResult.error})`);
    assert.deepEqual(rejectionResult.recipients, expected, `Level ${level} rejection includes only previous configured recipients, with the Level 1 fallback`);
    assert.equal(lifecycleSend.to, expected.join(', '), `Level ${level} rejection send contains the required configured recipient set`);
    assert.deepEqual(lifecycleSend.cc, [], 'rejection notice does not add unrelated global CC recipients');
    assert.deepEqual(lifecycleSend.bcc, [], 'rejection notice does not add unrelated global BCC recipients');
  }

  const allApprovers = chain.flatMap((entry) => entry.recipients);
  const completionResult = await lifecycleService._sendCompletionMail(lifecycleArgs);
  assert(completionResult.ok, `all-approver completion email sends without creator email (${completionResult.error})`);
  assert.deepEqual(completionResult.recipients, allApprovers, 'completion notice recipients contain every configured approver');
  assert.equal(lifecycleSend.to, allApprovers.join(', '), 'completion SMTP To contains all configured approvers');
  assert.deepEqual(lifecycleSend.cc, [], 'completion notice has no additional CC recipients');
  assert.deepEqual(lifecycleSend.bcc, [], 'completion notice has no additional BCC recipients');

  const groupingService = new PoMailService({ client: {}, sender: {}, repository: {}, Routing: {} });
  const duplicateRows = [
    { PurchaseOrder: TEST_GROUP_PO, PurchaseOrderItem: '00010', CompanyCode: '1000', PurchaseOrderType: 'ZSER', Currency: 'INR', OrderQuantity: 10, NetPrice: 250 },
    { PurchaseOrder: TEST_GROUP_PO, PurchaseOrderItem: '00020', CompanyCode: '1000', PurchaseOrderType: 'ZSER', Currency: 'INR', OrderQuantity: 4, NetPrice: 500 },
    { PurchaseOrder: TEST_GROUP_PO, PurchaseOrderItem: '00010', CompanyCode: '1000', PurchaseOrderType: 'ZSER', Currency: 'INR', OrderQuantity: 10, NetPrice: 250 }
  ];
  const grouped = groupingService._groupAndNormalize(duplicateRows);
  assert.equal(grouped.length, 1, 'repeated source rows remain one PO');
  assert.equal(grouped[0].items.length, 2, 'each SAP line item is rendered only once');

  let notifiedLevel = 0;
  let progressAdvance = null;
  const workflowService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 1,
        NmbrOfActiveWrkflwDialogTasks: 1,
        PurchasingProcessingStatus: '03'
      }] })
    },
    sender: {}, repository: {}, Routing: {}
  });
  workflowService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 0, MAX_LEVEL: 3
    }],
    advance: async (entry) => { progressAdvance = entry; }
  };
  workflowService._sendLevelMail = async ({ level }) => {
    notifiedLevel = level;
    return { ok: true, recipients: ['level2@example.test'], messageId: 'test-message' };
  };
  const routing = {
    resolve: () => ({ ruleId: 'DESTINATION_RULE' }),
    approvalChain: () => chain,
    isAutoApprove: () => false
  };
  await workflowService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(notifiedLevel, 2, 'one completed S/4 dialog task triggers the destination-configured Level 2 notification');
  assert.equal(progressAdvance.completedTasks, 1, 'workflow checkpoint advances only after the next-level mail succeeds');

  let approved05NotifiedLevel = 0;
  let approved05Advance = null;
  const approved05Service = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 1,
        NmbrOfActiveWrkflwDialogTasks: 0,
        PurchasingProcessingStatus: '03'
      }] }),
      getPurchaseOrderProcessingStatus: async () => '05'
    },
    sender: {}, repository: {}, Routing: {}
  });
  approved05Service.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 0, MAX_LEVEL: 3
    }],
    advance: async (entry) => { approved05Advance = entry; }
  };
  approved05Service._sendLevelMail = async ({ level }) => {
    approved05NotifiedLevel = level;
    return { ok: true, recipients: [`level${level}@example.test`] };
  };
  approved05Service._sendRejectionMail = async () => {
    throw new Error('Status 05 is an approval-stage status in this scenario, not rejection.');
  };
  await approved05Service._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(approved05NotifiedLevel, 2, 'status 05 plus an active next task sends the next-level approval notification');
  assert.equal(approved05Advance.completedTasks, 1, 'status 05 approval-stage notification advances the checkpoint');

  const catchupLevels = [];
  let catchupCompletionCount = 0;
  const catchupAdvances = [];
  const catchupService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 3,
        PurchasingProcessingStatus: '05'
      }] })
    },
    sender: {}, repository: {}, Routing: {}
  });
  catchupService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 0, MAX_LEVEL: 3
    }],
    advance: async (entry) => { catchupAdvances.push(entry); }
  };
  catchupService._sendLevelMail = async ({ level }) => {
    catchupLevels.push(level);
    return { ok: true, recipients: [`level${level}@example.test`], messageId: `level-${level}` };
  };
  catchupService._sendCompletionMail = async () => {
    catchupCompletionCount += 1;
    return { ok: true, recipients: ['all-levels@example.test'], messageId: 'completion' };
  };
  await catchupService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.deepEqual(catchupLevels, [2, 3], 'a task-count jump catches up each skipped notification level in order');
  assert.equal(catchupCompletionCount, 1, 'catch-up sends one final completion notice after Level 2 and Level 3');
  assert.deepEqual(catchupAdvances.map((entry) => entry.completedTasks), [1, 2, 3], 'checkpoint advances after each successfully notified stage');
  assert.equal(catchupAdvances[2].trackingStatus, 'COMPLETE', 'catch-up marks the tracker complete after the final notice');

  let completionRecipients = [];
  let completionAdvance = null;
  const completionService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 3,
        PurchasingProcessingStatus: '05'
      }] })
    },
    sender: {}, repository: {}, Routing: {}
  });
  completionService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 2, MAX_LEVEL: 3
    }],
    advance: async (entry) => { completionAdvance = entry; }
  };
  completionService._sendCompletionMail = async ({ chain: configuredChain }) => {
    completionRecipients = [...new Set(configuredChain.flatMap((entry) => entry.recipients))];
    return { ok: true, recipients: completionRecipients, messageId: 'completion-message' };
  };
  await completionService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.deepEqual(completionRecipients, chain.flatMap((entry) => entry.recipients), 'completion notice is addressed to every configured approver');
  assert.equal(completionAdvance.completedTasks, 3, 'final approval advances the workflow checkpoint');
  assert.equal(completionAdvance.trackingStatus, 'COMPLETE', 'final approval marks the workflow checkpoint complete');

  const oneLevelChain = [{ level: 1, recipients: ['level1@example.test'] }];
  let oneLevelCompletionRecipients = [];
  let oneLevelCompletionAdvance = null;
  const oneLevelCompletionService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'NB',
        NmbrOfCmpltdWrkflwDialogTasks: 1,
        PurchasingProcessingStatus: '05'
      }] })
    },
    sender: {}, repository: {}, Routing: {}
  });
  oneLevelCompletionService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'NB',
      LAST_COMPLETED_TASKS: 0, MAX_LEVEL: 1
    }],
    advance: async (entry) => { oneLevelCompletionAdvance = entry; }
  };
  oneLevelCompletionService._sendCompletionMail = async ({ chain: configuredChain }) => {
    oneLevelCompletionRecipients = [...new Set(configuredChain.flatMap((entry) => entry.recipients))];
    return { ok: true, recipients: oneLevelCompletionRecipients };
  };
  const oneLevelRouting = {
    resolve: () => ({ ruleId: 'ONE_LEVEL_RULE' }),
    approvalChain: () => oneLevelChain,
    isAutoApprove: () => false
  };
  await oneLevelCompletionService._pollS4WorkflowProgress({ routing: oneLevelRouting, smtpConfig: {} });
  assert.deepEqual(oneLevelCompletionRecipients, ['level1@example.test'], 'one-level sequential route sends completion to all configured approvers after final approval');
  assert.equal(oneLevelCompletionAdvance.trackingStatus, 'COMPLETE', 'one-level final approval marks the workflow complete');

  let rejectionMailCount = 0;
  const rejectionAdvances = [];
  for (const rejectionCase of [
    { level: 1, lastCompleted: 0, completed: 1 },
    { level: 2, lastCompleted: 1, completed: 2 },
    { level: 3, lastCompleted: 2, completed: 3 }
  ]) {
    const rejectedService = new PoMailService({
      client: {
        getPurchaseOrders: async () => ({ rows: [{
          PurchaseOrder: TEST_PO,
          CompanyCode: '1000',
          PurchaseOrderType: 'ZSER',
          PurchasingProcessingStatus: '05',
          NmbrOfCmpltdWrkflwDialogTasks: rejectionCase.completed
        }] }),
        getPurchaseOrderProcessingStatus: async () => '08'
      },
      sender: {}, repository: {}, Routing: {}
    });
    rejectedService.workflowProgress = {
      listActive: async () => [{
        PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
        LAST_COMPLETED_TASKS: rejectionCase.lastCompleted, MAX_LEVEL: 3
      }],
      advance: async (entry) => { rejectionAdvances.push(entry); }
    };
    rejectedService._sendRejectionMail = async ({ chain: configuredChain, rejectedLevel }) => {
      rejectionMailCount += 1;
      const notifiedLevels = rejectedLevel === 1
        ? configuredChain.filter((entry) => entry.level === 1)
        : configuredChain.filter((entry) => entry.level < rejectedLevel);
      const recipients = [...new Set(notifiedLevels.flatMap((entry) => entry.recipients))];
      assert.equal(rejectedLevel, rejectionCase.level, `S/4 rejection is routed at Level ${rejectionCase.level}`);
      assert(
        notifiedLevels.every((entry) => rejectedLevel === 1 ? entry.level === 1 : entry.level < rejectedLevel),
        `Level ${rejectedLevel} notice goes to previous levels only (with Level 1 fallback)`
      );
      return { ok: true, recipients, messageId: `rejected-${rejectionCase.level}` };
    };
    rejectedService._sendLevelMail = async () => {
      throw new Error('Rejected workflow must not trigger another approval-level email.');
    };
    rejectedService._sendCompletionMail = async () => {
      throw new Error('Rejected workflow must not trigger an approved completion email.');
    };
    await rejectedService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  }
  assert.equal(rejectionMailCount, 3, 'rejection at Levels 1, 2, and 3 each sends one rejection notification');
  assert(rejectionAdvances.every((entry) => entry.trackingStatus === 'REJECTED'), 'each rejected workflow is terminal in the existing checkpoint');
  assert.deepEqual(rejectionAdvances.map((entry) => entry.completedTasks), [1, 2, 3], 'each rejection checkpoint retains the observed S/4 task count');

  let raceRejectionLevel = 0;
  let raceAdvance = null;
  const raceService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        PurchasingProcessingStatus: '08',
        NmbrOfCmpltdWrkflwDialogTasks: 2,
        NmbrOfActiveWrkflwDialogTasks: 1
      }] }),
      getPurchaseOrderProcessingStatus: async () => '03'
    },
    sender: {}, repository: {}, Routing: {}
  });
  raceService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 1, MAX_LEVEL: 3
    }],
    advance: async (entry) => { raceAdvance = entry; }
  };
  raceService._sendRejectionMail = async ({ rejectedLevel }) => {
    raceRejectionLevel = rejectedLevel;
    return { ok: true, recipients: ['level1@example.test'], messageId: 'view-rejected' };
  };
  raceService._sendLevelMail = async () => {
    throw new Error('A view-reported rejection must not trigger another approval-level email.');
  };
  raceService._sendCompletionMail = async () => {
    throw new Error('A view-reported rejection must not trigger a completion email.');
  };
  await raceService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(raceRejectionLevel, 2, 'view status 08 with a stale active API status still routes the rejection at Level 2');
  assert(raceAdvance && raceAdvance.trackingStatus === 'REJECTED', 'view-reported rejection advances the checkpoint to terminal REJECTED');

  let zeroActiveRejectionLevel = 0;
  let zeroActiveRejectionAdvance = null;
  const zeroActiveRejectionService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 2,
        NmbrOfActiveWrkflwDialogTasks: 0,
        PurchasingProcessingStatus: '03'
      }] }),
      getPurchaseOrderProcessingStatus: async () => '03'
    },
    sender: {}, repository: {}, Routing: {}
  });
  zeroActiveRejectionService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 1, MAX_LEVEL: 3
    }],
    advance: async (entry) => { zeroActiveRejectionAdvance = entry; }
  };
  zeroActiveRejectionService._sendRejectionMail = async ({ rejectedLevel }) => {
    zeroActiveRejectionLevel = rejectedLevel;
    return { ok: true, recipients: ['level1@example.test'] };
  };
  zeroActiveRejectionService._sendLevelMail = async () => {
    throw new Error('Zero active tasks after Level 2 rejection must not trigger Level 3 mail.');
  };
  zeroActiveRejectionService._sendCompletionMail = async () => {
    throw new Error('Rejected workflow must not send an approved completion notice.');
  };
  await zeroActiveRejectionService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(zeroActiveRejectionLevel, 2, '2 completed and 0 active tasks on a 3-level route is classified as Level 2 rejection');
  assert.equal(zeroActiveRejectionAdvance.trackingStatus, 'REJECTED', 'zero-active rejection is persisted as terminal REJECTED');
  assert.equal(zeroActiveRejectionAdvance.completedTasks, 2, 'zero-active rejection checkpoint saves observed completed task count');

  let missingStatusLevelMailCount = 0;
  let missingStatusAdvanceCount = 0;
  const missingStatusService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 1
      }] })
    },
    sender: {}, repository: {}, Routing: {}
  });
  missingStatusService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 0, MAX_LEVEL: 3
    }],
    advance: async () => { missingStatusAdvanceCount += 1; }
  };
  missingStatusService._sendLevelMail = async () => {
    missingStatusLevelMailCount += 1;
    return { ok: true };
  };
  await missingStatusService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(missingStatusLevelMailCount, 0, 'counter increase without processing status fails closed');
  assert.equal(missingStatusAdvanceCount, 0, 'checkpoint is not advanced when approval versus rejection is unknown');

  let noActiveTaskNextLevelCount = 0;
  let noActiveTaskAdvanceCount = 0;
  const noActiveTaskService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        NmbrOfCmpltdWrkflwDialogTasks: 1,
        NmbrOfActiveWrkflwDialogTasks: 0,
        PurchasingProcessingStatus: '03'
      }] }),
      getPurchaseOrderProcessingStatus: async () => '03'
    },
    sender: {}, repository: {}, Routing: {}
  });
  noActiveTaskService.workflowProgress = {
    listActive: async () => [{
      PO_NUMBER: TEST_PO, COMPANY_CODE: '1000', DOCUMENT_TYPE: 'ZSER',
      LAST_COMPLETED_TASKS: 1, MAX_LEVEL: 3
    }],
    advance: async () => { noActiveTaskAdvanceCount += 1; }
  };
  noActiveTaskService._sendLevelMail = async () => {
    noActiveTaskNextLevelCount += 1;
    return { ok: true };
  };
  await noActiveTaskService._pollS4WorkflowProgress({ routing, smtpConfig: {} });
  assert.equal(noActiveTaskNextLevelCount, 0, 'task-count increase with no active S/4 task does not notify the next level');
  assert.equal(noActiveTaskAdvanceCount, 0, 'checkpoint waits for an active next workflow task');

  let failClosedSendCount = 0;
  const failClosedService = new PoMailService({
    client: {
      getPurchaseOrders: async () => ({ rows: [{
        PurchaseOrder: TEST_FAIL_CLOSED_PO,
        CompanyCode: '1000',
        PurchaseOrderType: 'ZSER',
        CreationDate: '2026-11-04',
        Currency: 'INR'
      }] })
    },
    sender: {
      config: async () => ({ cc: [], bcc: [] }),
      send: async () => { failClosedSendCount += 1; return { sent: true }; }
    },
    repository: {
      getLastRunWatermark: () => null,
      setLastRunWatermark: () => {},
      filterAlreadySent: async () => new Set()
    },
    Routing: {
      fromConfig: () => ({ schemaVersion: '1', onAmbiguousMatch: 'ERROR', rules: [], parseErrors: [] })
    }
  });
  failClosedService.workflowProgress = {
    listActive: async () => [],
    get: async () => { throw new Error('workflow table unavailable'); }
  };
  const failClosedResult = await failClosedService.run();
  assert.equal(failClosedSendCount, 0, 'live run sends no email when persistent workflow duplicate-check is unavailable');
  assert.equal(failClosedResult.degraded, true, 'fail-closed live run reports degraded state');
  assert(failClosedResult.message.includes('persistent workflow checkpoint is unavailable'), 'fail-closed reason is returned');

  console.log('ALL S/4 MY INBOX NOTIFICATION TESTS PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});