'use strict';
const fs = require('fs');
const path = require('path');

const PoApprovalRouting = require('../services/PoApprovalRouting');
const S4PoClient = require('../services/S4PoClient');
const PoMailSender = require('../services/PoMailSender');
const Constants = require('../constants/PoConstants');
const PoMailService = require('../services/PoMailService');
const Mapper = require('../utils/PoFieldMapper');
const { amountInWords, formatMoney } = require('../utils/PoAmountUtil');
const { parseSapDate, formatDate } = require('../utils/PoDateUtil');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function equals(label, actual, expected) {
  check(label, actual === expected, `expected "${expected}", got "${actual}"`);
}

const RULES = [
  { key: 'mail.po.approval.rule.01', raw: JSON.stringify({ ruleId: 'R01', companyCodes: ['1000', '4000'], documentTypes: ['ZSER', 'ZASS'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['priyanshu.s@truspeq.com'], 2: ['priya.p@truspeq.com'], 3: ['deepika.n@truspeq.com'] } }) },
  { key: 'mail.po.approval.rule.02', raw: JSON.stringify({ ruleId: 'R02', companyCodes: ['2000'], documentTypes: ['ZSER', 'ZASS'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['priyanshu.s@truspeq.com'], 2: ['priya.p@truspeq.com'], 3: ['deepika.n@truspeq.com'] } }) },
  { key: 'mail.po.approval.rule.05', raw: JSON.stringify({ ruleId: 'R05', companyCodes: ['1000', '4000'], documentTypes: ['ZREC'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['priyanshu.s@truspeq.com'], 2: ['priya.p@truspeq.com'] } }) },
  { key: 'mail.po.approval.rule.09', raw: JSON.stringify({ ruleId: 'R09', companyCodes: ['1000', '2000', '3000', '4000', '5000'], documentTypes: ['ZTRP'], action: 'AUTO_APPROVE', approvalLevels: {} }) },
  { key: 'mail.po.approval.rule.10', raw: JSON.stringify({ ruleId: 'R10', companyCodes: ['1000', '4000'], documentTypes: ['NB'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['priyanshu.s@truspeq.com'] } }) }
];

const PO_HEADER = {
  PurchaseOrder: '4500000012',
  PurchaseOrderType: 'ZSER',
  CompanyCode: '1000',
  CreationDate: '/Date(1792663200000)/',           
  CreatedByUser: 'MOBI_S4USER',
  Supplier: '1000234',
  SupplierName: 'ACME Facility Services Pvt Ltd',
  SupplierStreet: 'Plot 12, Hitec City',
  SupplierCity: 'Hyderabad',
  SupplierPostalCode: '500081',
  SupplierRegion: 'Telangana',
  SupplierCountry: 'IN',
  SupplierVATNumber: '36AABCA1234F1Z5',
  Currency: 'INR',
  NmbrOfCmpltdWrkflwDialogTasks: 0,
  NmbrOfActiveWrkflwDialogTasks: 1,
  PaymentTermsText: 'Net 30 days from invoice receipt',
  PurchasingOrganization: '1000',
  PurchasingGroup: 'P01',
  HeaderText: 'Annual maintenance contract - Q4 2026.\nPlease confirm the visit schedule before dispatch.',
  CompanyAddress: 'MOBI Innovation Campus, Tower B, Outer Ring Road, Bengaluru 560103, Karnataka, IN',
  Region: '14',
  Country: 'MY',
  Region_1: 'BL',
  Country_1: 'MU',
  to_Item: {
    results: [
      { PurchaseOrderItem: '00010', Material: 'SRV-001', PurchaseOrderItemText: 'Hardware repairs & services', MaterialName: 'AMC - preventive maintenance visit', ScheduleLineDeliveryDate: '2026-07-28T00:00:00', DeliveryDate: '2026-11-05', OrderQuantity: 4, PurchaseOrderQuantityUnit: 'EA', NetPrice: 25000, TaxCode: 'G1', TaxPercentage: 18 },
      { PurchaseOrderItem: '00020', Material: 'SRV-002', MaterialName: 'Spare parts kit (OEM)', DeliveryDate: '2026-11-20', OrderQuantity: 1, PurchaseOrderQuantityUnit: 'ST', NetPrice: 14500, TaxCode: 'G1', TaxPercentage: 18 }
    ]
  }
};

class StubClient {
  constructor(rows) { this.rows = rows; }
  async getPurchaseOrders() { return { rows: this.rows, range: null, degraded: false }; }
}

class StubSender {
  constructor(config) { this._config = config; this.calls = []; }
  async config() { return this._config; }
  async logoAttachment() { return { available: false, attachment: null }; }
  async send(message) {
    this.calls.push(message);
    if (message.dryRun) {
      return { sent: false, dryRun: true, to: message.to, messageId: '', source: 'stub (dry run)' };
    }
    return { sent: true, messageId: `stub-${this.calls.length}@mobi.xyz`, to: message.to, source: 'stub' };
  }
}

class StubRepository {
  constructor(sent = new Set()) { this.sent = sent; this.records = []; }
  async filterAlreadySent(candidates) {
    return new Set(candidates
      .filter((c) => this.sent.has(`${c.companyCode}|${c.poNumber}`))
      .map((c) => `${c.companyCode}|${c.poNumber}`));
  }
  async record(entry) { this.records.push(entry); return false; }
  getLastRunWatermark() { return null; }
  setLastRunWatermark() {}
  describe() { return { mode: 'IN_MEMORY', entity: 'stub', inMemorySentCount: 0, lastRunWatermark: null }; }
}

const SMTP_CONFIG = {
  host: 'smtp.office365.com',
  port: 587,
  user: 'sappostingnotification@mobi.xyz',
  password: '***',
  from: 'sappostingnotification@mobi.xyz',
  fromName: 'MOBI Purchase Order',
  cc: ['global-copy@example.test'],
  bcc: ['global-blind-copy@example.test'],
  secure: false,
  requireTLS: true,
  schemaVersion: '1',
  onAmbiguousMatch: 'ERROR',
  ruleEntries: RULES,
  source: "BTP destination 'SMTP_MOBI_PO_DEV'"
};

function buildService(rows, sentSet) {
  const sender = new StubSender(SMTP_CONFIG);
  const repository = new StubRepository(sentSet);
  const service = new PoMailService({
    client: new StubClient(rows),
    sender,
    repository,
    Routing: PoApprovalRouting
  });
  service.workflowProgress = {
    listActive: async () => [],
    get: async () => null,
    initialize: async () => null,
    advance: async () => null
  };
  return { service, sender, repository };
}

console.log('\n[1] Amount in words');
equals('INR 125345.60', amountInWords(125345.60, 'INR'), 'Rupees One Lakh Twenty Five Thousand Three Hundred Forty Five and Paise Sixty Only');
equals('INR 118000', amountInWords(118000, 'INR'), 'Rupees One Lakh Eighteen Thousand Only');
equals('INR 10000000', amountInWords(10000000, 'INR'), 'Rupees One Crore Only');
equals('USD 1250.25', amountInWords(1250.25, 'USD'), 'Dollars One Thousand Two Hundred Fifty and Cents Twenty Five Only');
equals('INR 0', amountInWords(0, 'INR'), 'Rupees Zero Only');
equals('formatMoney INR', formatMoney(125345.6, 'INR', 2), 'INR 1,25,345.60');
equals('formatMoney USD', formatMoney(125345.6, 'USD', 2), 'USD 125,345.60');

console.log('\n[2] SAP date parsing');
equals('/Date(ms)/ -> dd.MM.yyyy', formatDate('/Date(1792663200000)/'), formatDate(parseSapDate('/Date(1792663200000)/')));
equals('OData V4 date', formatDate('2026-11-05'), '05.11.2026');
equals('DATS 20261105', formatDate('20261105'), '05.11.2026');
equals('initial date is blank', formatDate('0000-00-00'), '');

console.log('\n[3] Field mapping + derived money');
{
  const service = buildService([PO_HEADER]).service;
  const po = service._normalize(PO_HEADER, Mapper.resolveItemRows(PO_HEADER));
  equals('PO Number', po.poNumber, '4500000012');
  equals('Company Code', po.companyCode, '1000');
  equals('Document Type', po.documentType, 'ZSER');
  equals('Completed S/4 workflow dialog tasks', po.workflowCompletedDialogTasks, 0);
  equals('Active S/4 workflow dialog tasks', po.workflowActiveDialogTasks, 1);
  equals('Supplier Code', po.supplierCode, '1000234');
  equals('Supplier Name', po.supplierName, 'ACME Facility Services Pvt Ltd');
  equals('Company Address uses Region + Country only', po.companyAddress, '14, MY');
  equals('Supplier Address uses Region_1 + Country_1 only', po.supplierAddress, 'BL, MU');
  equals('Supplier Tax Number', po.supplierTaxNumber, '36AABCA1234F1Z5');
  equals('Payment Terms', po.paymentTerms, 'Net 30 days from invoice receipt');
  equals('Header Text keeps newline', po.headerText.includes('\n'), true);
  equals('Purchasing Organization', po.purchasingOrganization, '1000');
  equals('Purchasing Group', po.purchasingGroup, 'P01');
  equals('item count', po.items.length, 2);
  equals('Sl. No from 00010', po.items[0].slNo, '1');
  equals('Item from 00010', po.items[0].item, '00010');
  equals('Description from PurchaseOrderItemText', po.items[0].description, 'Hardware repairs & services');
  equals('Delivery Date from ScheduleLineDeliveryDate', po.items[0].deliveryDate, '28.07.2026');
  equals('Quantity + unit', po.items[0].quantity, '4 EA');
  equals('Unit Price', po.items[0].unitPrice, '25,000.00');
  equals('Tax %', po.items[0].taxPercent, '18%');
  equals('ConditionRateRatio maps as tax %', Mapper.ITEM.taxPercent({ ConditionRateRatio: '18' }), 18);
  equals('Base Price derived', po.items[0].basePrice, '1,00,000.00');
  equals('Tax derived', po.items[0].tax, '18,000.00');
  equals('Line Total derived', po.items[0].total, '1,18,000.00');

  const derivedTaxPo = service._normalize(PO_HEADER, [{
    PurchaseOrderItem: '00030',
    OrderQuantity: 1,
    NetPrice: 1000,
    NetAmount: 1000,
    TaxAmount: 180,
    TaxCode: 'V1'
  }]);
  equals('Tax % derived from tax amount when rate is absent', derivedTaxPo.items[0].taxPercent, '18%');

  const missingTaxRatePo = service._normalize(PO_HEADER, [{
    PurchaseOrderItem: '00040',
    OrderQuantity: 1,
    NetPrice: 1000,
    TaxCode: 'V1'
  }]);
  equals('Missing rate does not display false 0%', missingTaxRatePo.items[0].taxPercent, 'V1');

  equals('Total Base Price', po.totals.totalBasePrice, 'INR 1,14,500.00');
  equals('Total Tax', po.totals.totalTax, 'INR 20,610.00');
  equals('Net PO Value', po.totals.totalAmount, 'INR 1,35,110.00');
  equals('Net PO Value in words', po.totals.totalAmountInWords,
    'Rupees One Lakh Thirty Five Thousand One Hundred Ten Only');
}

console.log('\n[4] Approval routing (real destination rules)');
{
  const routing = new PoApprovalRouting({ ruleEntries: RULES, onAmbiguousMatch: 'ERROR' });
  equals('rules parsed', routing.rules.length, 5);
  equals('1000/ZSER -> R01', routing.resolve('1000', 'ZSER').ruleId, 'R01');
  equals('4000/ZASS -> R01', routing.resolve('4000', 'ZASS').ruleId, 'R01');
  equals('2000/ZSER -> R02', routing.resolve('2000', 'ZSER').ruleId, 'R02');
  equals('1000/ZREC -> R05', routing.resolve('1000', 'ZREC').ruleId, 'R05');
  equals('3000/ZTRP -> R09', routing.resolve('3000', 'ZTRP').ruleId, 'R09');
  equals('1000/NB -> R10', routing.resolve('1000', 'NB').ruleId, 'R10');
  equals('case-insensitive doc type', routing.resolve('1000', 'zser').ruleId, 'R01');
  equals('R09 is AUTO_APPROVE', routing.isAutoApprove(routing.resolve('1000', 'ZTRP')), true);
  equals('R01 is not AUTO_APPROVE', routing.isAutoApprove(routing.resolve('1000', 'ZSER')), false);
  check('Level 1 recipients of R01',
    JSON.stringify(routing.recipientsForLevel(routing.resolve('1000', 'ZSER'), 1))
    === JSON.stringify(['priyanshu.s@truspeq.com']));
  equals('approval chain has 3 levels', routing.approvalChain(routing.resolve('1000', 'ZSER')).length, 3);
  equals('ZREC chain has 2 levels', routing.approvalChain(routing.resolve('1000', 'ZREC')).length, 2);

  let threw = false;
  try { routing.resolve('9999', 'ZSER'); } catch (_) { threw = true; }
  check('no match throws', threw);

  const WILDCARD_RULE_ENTRIES = [
    { key: 'mail.po.approval.rule.01', raw: JSON.stringify({ ruleId: 'WA', companyCodes: ['*'], documentTypes: ['ZSER'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['a@x.com'] } }) },
    { key: 'mail.po.approval.rule.02', raw: JSON.stringify({ ruleId: 'WB', companyCodes: ['*'], documentTypes: ['ZSER'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['b@x.com'] } }) }
  ];
  const wildcardRouting = new PoApprovalRouting({ ruleEntries: WILDCARD_RULE_ENTRIES, onAmbiguousMatch: 'ERROR' });
  threw = false;
  try { wildcardRouting.resolve('1000', 'ZSER'); } catch (error) { threw = /Ambiguous/.test(error.message); }
  check('equal-specificity tie + onAmbiguousMatch=ERROR throws', threw);

  const firstRouting = new PoApprovalRouting({ ruleEntries: WILDCARD_RULE_ENTRIES, onAmbiguousMatch: 'FIRST' });
  equals('onAmbiguousMatch=FIRST picks lowest rule', firstRouting.resolve('1000', 'ZSER').ruleId, 'WA');

  const brokenRouting = new PoApprovalRouting({
    ruleEntries: [{ key: 'mail.po.approval.rule.99', raw: '{not json' }],
    onAmbiguousMatch: 'ERROR'
  });
  equals('broken JSON rule is reported, not fatal', brokenRouting.parseErrors.length, 1);

  const specificRouting = new PoApprovalRouting({
    ruleEntries: [
      ...RULES,
      { key: 'mail.po.approval.rule.20', raw: JSON.stringify({ ruleId: 'SPEC', companyCodes: ['1000'], documentTypes: ['ZSER'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['c@x.com'] } }) },
      { key: 'mail.po.approval.rule.21', raw: JSON.stringify({ ruleId: 'WILD', companyCodes: ['*'], documentTypes: ['*'], action: 'SEQUENTIAL_APPROVAL', approvalLevels: { 1: ['d@x.com'] } }) }
    ],
    onAmbiguousMatch: 'ERROR'
  });
  equals('most specific rule wins over wildcard', specificRouting.resolve('1000', 'ZSER').ruleId, 'SPEC');
  equals('wildcard catches unmatched doc type', specificRouting.resolve('3000', 'ZZZZ').ruleId, 'WILD');
}

console.log('\n[5] End-to-end run (stubbed transport)');

(async () => {
  const { service, sender, repository } = buildService([PO_HEADER]);
  const result = await service.run({ lookbackDays: 7, actor: 'TESTER' });

  equals('read', result.read, 1);
  equals('new', result.new, 1);
  equals('mailed', result.mailed, 1);
  equals('failed', result.failed, 0);
  equals('one mail sent', sender.calls.length, 1);
  equals('recipients = configured level 1 only', sender.calls[0].to, 'priyanshu.s@truspeq.com');
  equals('no destination-wide CC is added to level 1', JSON.stringify(sender.calls[0].cc), '[]');
  equals('no destination-wide BCC is added to level 1', JSON.stringify(sender.calls[0].bcc), '[]');
  check('level 2/3 approvers are NOT mailed on creation',
    !/deepika\.n@|priya\.p@|indraja\.r@|sharath\.c@/.test(sender.calls[0].to), sender.calls[0].to);
  check('subject carries PO number', /4500000012/.test(sender.calls[0].subject), sender.calls[0].subject);
  check('subject carries level', /Level 1/.test(sender.calls[0].subject));
  equals('log written as SENT', repository.records[0]?.status, 'SENT');

  const second = buildService([PO_HEADER], new Set(['1000|4500000012']));
  const result2 = await second.service.run({ lookbackDays: 7 });
  equals('duplicate PO skipped', result2.mailed, 0);
  equals('duplicate counted', result2.skippedAlreadySent, 1);
  equals('no mail sent on duplicate', second.sender.calls.length, 0);

  const autoRow = { ...PO_HEADER, PurchaseOrder: '4500000099', PurchaseOrderType: 'ZTRP' };
  const third = buildService([autoRow]);
  const result3 = await third.service.run({ lookbackDays: 7 });
  equals('ZTRP auto-approved, no mail', result3.skippedAutoApprove, 1);
  equals('ZTRP mailed count', result3.mailed, 0);
  equals('ZTRP sent no mail', third.sender.calls.length, 0);

  const badRow = { ...PO_HEADER, PurchaseOrder: '4500000100', CompanyCode: '9999' };
  const fourth = buildService([badRow]);
  const result4 = await fourth.service.run({ lookbackDays: 7 });
  equals('unroutable PO -> skippedNoApprover', result4.skippedNoApprover, 1);
  check('unroutable PO carries the routing error', /No PO approval routing rule matches/.test(result4.purchaseOrders[0].error));

  const fifth = buildService([{ ...PO_HEADER, PurchaseOrder: '4500000101' }]);
  const result5 = await fifth.service.run({ lookbackDays: 7, dryRun: true });
  equals('dryRun does not hand anything to the transport', fifth.sender.calls.filter((call) => !call.dryRun).length, 0);
  equals('dryRun writes no log', fifth.repository.records.length, 0);
  equals('dryRun still reports the entry', result5.purchaseOrders[0].status, 'DRY_RUN');
  equals('dryRun counted separately from mailed', result5.mailed, 0);
  equals('dryRun prepared count', result5.dryRunPrepared, 1);
  equals('dryRun resolved the same level-1 approvers', result5.purchaseOrders[0].recipients.join(', '),
    'priyanshu.s@truspeq.com');

  let capturedSmtpMessage = null;
  const isolatedSender = new PoMailSender({ config: SMTP_CONFIG });
  isolatedSender._transporter = {
    sendMail: async (message) => { capturedSmtpMessage = message; return { messageId: 'stub-isolated-message' }; }
  };
  const isolatedSendResult = await isolatedSender.send({
    to: ['priyanshu.s@truspeq.com'],
    cc: [],
    bcc: [],
    subject: 'Routed-recipient test',
    html: '<p>Test</p>',
    embedLogo: false
  });
  equals('isolated routed mail sends successfully', isolatedSendResult.sent, true);
  equals('sender does not append destination-wide CC', capturedSmtpMessage.cc, undefined);
  equals('sender does not append destination-wide BCC', capturedSmtpMessage.bcc, undefined);

    console.log('\n[7] S4PoClient against the real YY1_PO_EMAIL view');
  {
    const STUB_DESTINATION = {
      url: 'https://my436974-api.s4hana.cloud.sap',
      name: 'S4HANA_MOBI',
      authTokens: [{ type: 'Bearer', value: 'STUB_TOKEN' }]
    };
    class TestPoClient extends S4PoClient {
      async _getDestination() { return STUB_DESTINATION; }
    }

    const calls = [];
    let nextResponse = null;
    global.fetch = async (url) => {
      calls.push(String(url));
      if (nextResponse) { const r = nextResponse; nextResponse = null; return r; }
      return { ok: true, status: 200, text: async () => '{"d":{"results":[]}}' };
    };

    equals('ENTITY_PATH points at YY1_PO_EMAIL', Constants.ENTITY_PATH, '/sap/opu/odata/sap/YY1_PO_EMAIL_CDS/YY1_PO_EMAIL');
    equals('ITEM_PATH defaults to AUTO', Constants.ITEM_PATH, '');
    equals('OData flavour is V2', Constants.ODATA_VERSION, 'V2');

    {
      const flatRows = [
        { PurchaseOrder: '4500000012', PurchaseOrderItem: '00010', CompanyCode: '1000', PurchaseOrderType: 'ZSER', CreationDate: '2026-10-21', OrderQuantity: 4, NetPrice: 25000, TaxPercentage: 18, Currency: 'INR' },
        { PurchaseOrder: '4500000012', PurchaseOrderItem: '00020', CompanyCode: '1000', PurchaseOrderType: 'ZSER', CreationDate: '2026-10-21', OrderQuantity: 1, NetPrice: 14500, TaxPercentage: 18, Currency: 'INR' }
      ];
      calls.length = 0;
      nextResponse = { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: flatRows } }) };
      const flatClient = new TestPoClient();
      const flat = await flatClient.getPurchaseOrders({ fromDate: new Date(Date.UTC(2026, 9, 15)) });
      equals('flat view: both rows read', flat.rows.length, 2);
    check('flat view: at most one $metadata read', calls.filter((u) => u.includes('$metadata')).length <= 1, calls.join('\n'));
    check('flat view: $metadata URL is the service root, not the host root',
      calls.filter((u) => u.includes('$metadata')).every((u) => u.includes('/sap/opu/odata/sap/YY1_PO_EMAIL_CDS/$metadata')), calls.join('\n'));
    equals('flat view: no navigation discovered', (flatClient._navProperties || []).length, 0);
    equals('flat view: no $expand invented', flatClient._expandClauseResolved, '');
      equals('flat view: $expand absent', /\$expand/.test(calls[0]), false);
      check('flat view: V2 datetime literal used', /datetime'2026-10-15T00:00:00'/.test(decodeURIComponent(calls[0])), calls[0]);
      check('flat view: entity path in the URL', calls[0].includes('/sap/opu/odata/sap/YY1_PO_EMAIL_CDS/YY1_PO_EMAIL'), calls[0]);

      const svc = buildService(flat.rows).service;
      const grouped = svc._groupAndNormalize(flat.rows);
      equals('flat rows grouped into ONE purchase order', grouped.length, 1);
      equals('flat view: 2 items on that PO', grouped[0].items.length, 2);
      equals('flat view: net value derived', grouped[0].totals.totalAmount, 'INR 1,35,110.00');

      calls.length = 0;
      nextResponse = { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: [PO_HEADER] } }) };
      const inlineClient = new TestPoClient();
      await inlineClient.getPurchaseOrders({ fromDate: new Date(Date.UTC(2026, 9, 15)) });
      check('inline items: no $metadata round trip', !calls.some((u) => u.includes('$metadata')), calls.join('\n'));

      const METADATA = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices>',
        '<Schema Namespace="YY1_PO_EMAIL_CDS" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">',
        '<EntityType Name="YY1_PO_EMAILType">',
        '<Key><PropertyRef Name="PurchaseOrder"/></Key>',
        '<Property Name="PurchaseOrder" Type="Edm.String" MaxLength="10"/>',
        '<Property Name="CompanyCode" Type="Edm.String" MaxLength="4"/>',
        '<NavigationProperty Name="to_Item" Relationship="YY1_PO_EMAIL_CDS.assoc_1" FromRole="FromRole_assoc_1" ToRole="ToRole_assoc_1"/>',
        '<NavigationProperty Name="to_Supplier" Relationship="YY1_PO_EMAIL_CDS.assoc_2" FromRole="FromRole_assoc_2" ToRole="ToRole_assoc_2"/>',
        '</EntityType>',
        '<EntityContainer Name="YY1_PO_EMAIL_CDSContainer" m:IsDefaultEntityContainer="true">',
        '<EntitySet Name="YY1_PO_EMAIL" EntityType="YY1_PO_EMAIL_CDS.YY1_PO_EMAILType"/>',
        '</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>'
      ].join('');

      calls.length = 0;
      const headerOnly = { PurchaseOrder: '4500000013', CompanyCode: '1000', PurchaseOrderType: 'ZSER' };
      let phase = 0;
      global.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).includes('$metadata')) { phase = 1; return { ok: true, status: 200, text: async () => METADATA }; }
        if (phase === 0) return { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: [headerOnly] } }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: [{ ...headerOnly, to_Item: { results: PO_HEADER.to_Item.results } }] } }) };
      };
      const discoverClient = new TestPoClient();
      const discovered = await discoverClient.getPurchaseOrders({ fromDate: new Date(Date.UTC(2026, 9, 15)) });
      check('header-only page triggered exactly one $metadata read', calls.filter((u) => u.includes('$metadata')).length === 1, calls.join('\n'));
      equals('navigation properties discovered', (discoverClient._navProperties || []).join(','), 'to_Item,to_Supplier');
      check('discovered navigation is used as $expand', calls.some((u) => decodeURIComponent(u).includes('$expand=to_Item,to_Supplier')), calls.join('\n'));
      equals('discovered+expanded read still returns the PO', discovered.rows.length, 1);

      calls.length = 0;
      global.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).includes('$metadata')) return { ok: false, status: 500, text: async () => 'boom' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: [headerOnly] } }) };
      };
      const brokenClient = new TestPoClient();
      const broken = await brokenClient.getPurchaseOrders({ fromDate: new Date(Date.UTC(2026, 9, 15)) });
      equals('$metadata failure degrades to no-expand instead of failing', broken.rows.length, 1);
      equals('degraded client cached an empty expand', brokenClient._expandClauseResolved, '');

      calls.length = 0;
      global.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify({ d: { results: [headerOnly] } }) }; };
      const explicit = new TestPoClient({ itemPath: 'to_Item' });
      await explicit.getPurchaseOrders({ fromDate: new Date(Date.UTC(2026, 9, 15)) });
      check('explicit PO_MAIL_ITEM_PATH: no $metadata call', !calls.some((u) => u.includes('$metadata')), calls.join('\n'));
      check('explicit PO_MAIL_ITEM_PATH: $expand=to_Item on the first read', /%24expand=to_Item/.test(calls[0]), calls[0]);
    }

    calls.length = 0;
    global.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ PurchaseOrder: 'TEST-PO', PurchasingProcessingStatus: '08' }] }) };
    };
    const statusClient = new TestPoClient();
    const processingStatus = await statusClient.getPurchaseOrderProcessingStatus('TEST-PO');
    equals('standard PO API returns rejected processing status', processingStatus, '08');
    check('processing-status query uses API_PURCHASEORDER_2 PO endpoint', calls[0].includes(Constants.PURCHASE_ORDER_API_PATH), calls[0]);
    const statusQuery = new URL(calls[0]).searchParams;
    check('processing-status query filters by the requested PO', statusQuery.get('$filter') === "PurchaseOrder eq 'TEST-PO'", calls[0]);
  }

  console.log('\n[8] In-app auto scheduler (no Job Scheduler needed)');
  {
    const Scheduler = require('../services/PoAutoScheduler');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    equals('auto-run disabled by default', Constants.AUTO_RUN_ENABLED, false);
    const idle = { calls: [], async send(action, params) { this.calls.push({ action, params }); return { message: 'ok' }; } };
    Scheduler.attach(idle);
    equals('attach() is a no-op while disabled', Scheduler.state.timer, null);

    Scheduler.start(idle, { intervalMs: 40, firstDelayMs: 10, dryRun: false });
    await sleep(130);
    check('timer ticked at least twice', idle.calls.length >= 2, `calls=${idle.calls.length}`);
    equals('tick invokes the same action as the POST', idle.calls[0].action, 'triggerPoMailNotification');
    equals('tick body is empty (watermark window)', JSON.stringify(idle.calls[0].params), '{}');
    Scheduler.stop();
    const frozen = idle.calls.length;
    await sleep(90);
    equals('stop() halts further ticks', idle.calls.length, frozen);

    const slow = { calls: [], send(action, params) { this.calls.push(params); return new Promise(() => {}); } };
    Scheduler.start(slow, { intervalMs: 30, firstDelayMs: 5, dryRun: true });
    await sleep(100);
    equals('PO_MAIL_AUTO_DRY_RUN reaches the action', slow.calls[0].dryRun, true);
    equals('overlapping ticks skipped while one run is in flight', slow.calls.length, 1);
    Scheduler.stop();
  }

  console.log('\n[9] S/4HANA My Inbox workflow notifications');
  {
    const { service, sender } = buildService([PO_HEADER], new Set());
    const runResult = await service.run({ purchaseOrder: '4500000012' });
    equals('level-1 notification is sent on PO creation', runResult.mailed, 1);
    const level1Html = sender.calls[0].html;
    check('mail is a notification for S/4HANA My Inbox', level1Html.includes('SAP S/4HANA My Inbox'));
    check('mail contains no Outlook approval card', !level1Html.includes('application/adaptivecard+json'));
    check('mail contains no direct Approve / Reject links', !level1Html.includes('Approve</a>') && !level1Html.includes('Reject</a>'));
    equals('completed workflow count is mapped', Mapper.HEADER.completedWorkflowDialogTasks(PO_HEADER), 0);
    equals('active workflow count is mapped', Mapper.HEADER.activeWorkflowDialogTasks(PO_HEADER), 1);
  }

  console.log('\n[6] Mail HTML preview');
  const html = sender.calls[0].html;
  const requiredLabels = [
    'Company Address', 'Supplier Code / Supplier', 'Supplier Name', 'Supplier Address',
    'Supplier Tax Number', 'PO Number', 'Date (Created On)', 'Payment Terms',
    'Currency', 'Sl. No', 'Item', 'Description', 'Delivery Date', 'Quantity', 'Unit Price',
    'Tax %', 'Base Price', 'Tax', 'Total Amount', 'Total Base Price',
    'Total Amount / Net PO Value', 'Total Amount in Words', 'Remarks (Header Text)',
    'Document Type', 'Created By', 'Company Code', 'Purchasing Organization',
    'Purchasing Group', 'Payment Terms', 'Approval Flow'
  ];
  const missing = requiredLabels.filter((label) => !html.includes(label));
  check(`all ${requiredLabels.length} field labels present in the mail`, missing.length === 0, `missing: ${missing.join(', ')}`);
  check('line-item totals row removed', !html.includes('>Totals</td>'));
  check('no email-based approval instructions remain', !html.includes('Click <b>Approve</b>') && !html.includes('Each link expires in'));
  check('logo slot present (text placeholder until mobi-logo.png is added)', html.includes('MOBI'));
  check('header text newline rendered as <br>', html.includes('Please confirm the visit schedule'));
  check('no password leaked into the mail', !html.includes('W@!C0me'));

  const previewDir = path.join(__dirname, 'preview');
  fs.mkdirSync(previewDir, { recursive: true });
  const previewFile = path.join(previewDir, 'po-mail-preview.html');
  fs.writeFileSync(previewFile, html, 'utf8');
  console.log(`  preview written -> ${previewFile}`);

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();