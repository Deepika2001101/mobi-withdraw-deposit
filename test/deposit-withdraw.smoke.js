'use strict';

/**
 * Deposit / Withdraw extension — standalone smoke test (no test framework).
 * Run with:  node test/deposit-withdraw.smoke.js
 *
 * Covers the shared catalog, normalization, scenario config, host-independent
 * GL lookup, the per-transaction Z4/Z3 builder, ingestion validation, and the
 * separate HOST_REFERENCE_ID / MERCHANT_REFERENCE_ID fields through persistence
 * and reversal archiving. Legacy PAYIN/PAYOUT/DOMESTIC SETTLEMENT behaviour is
 * asserted to be intact.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cds = require('@sap/cds');

const PaymentCatalog = require('../shared/payment/PaymentCatalog');
const NormalizeUtil = require('../consolidation/utils/NormalizeUtil');
const ScenarioConfig = require('../consolidation/config/ScenarioConfig');
const Builders = require('../consolidation/builders');
const { GLAccountLookup } = require('../consolidation/repositories/GLAccountRepository');
const ConsolidationRepository = require('../consolidation/repositories/ConsolidationRepository');
const ReversalRepository = require('../reversal/repositories/ReversalRepository');
const BusinessValidator = require('../txn-ingestion/validators/BusinessValidator');
const ValidationService = require('../txn-ingestion/services/ValidationService');

let passed = 0;
const pending = [];
function check(name, fn) {
  // Support both sync and async checks; async ones are awaited in main().
  const result = fn();
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => { passed += 1; console.log('  ok -', name); }));
  } else {
    passed += 1;
    console.log('  ok -', name);
  }
}

function insertEntity(q) {
  const into = q.INSERT.into;
  return (into && into.ref && into.ref[0]) || into;
}
function insertEntries(q) {
  const entries = q.INSERT.entries;
  return Array.isArray(entries) ? entries : [entries];
}
function selectEntity(q) {
  const from = q.SELECT.from;
  return (from && from.ref && from.ref[0]) || from;
}
function assertReferences(row, hostRef, merchantRef) {
  assert.strictEqual(row.HOST_REFERENCE_ID, hostRef);
  assert.strictEqual(row.MERCHANT_REFERENCE_ID, merchantRef);
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'ASSIGNMENT'), 'unexpected ASSIGNMENT field');
}

console.log('Schema');
check('consolidation + reversal tables carry both references, no ASSIGNMENT', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.cds'), 'utf8');
  const entities = [
    'MOBI_DB_CONSOLIDATIONHEADER',
    'MOBI_DB_CONSOLIDATIONLINEITEM',
    'MOBI_DB_CONSOLIDATIONHEADER_REVERSAL',
    'MOBI_DB_CONSOLIDATIONLINEITEM_REVERSAL'
  ];
  for (const name of entities) {
    const marker = `entity ${name} {`;
    const start = schema.indexOf(marker);
    assert.ok(start >= 0, `missing entity ${name}`);
    const block = schema.slice(start, schema.indexOf('}', start));
    assert.match(block, /HOST_REFERENCE_ID\s*:\s*String\(100\)/, `${name} HOST_REFERENCE_ID`);
    assert.match(block, /MERCHANT_REFERENCE_ID\s*:\s*String\(100\)/, `${name} MERCHANT_REFERENCE_ID`);
    assert.ok(!/\bASSIGNMENT\b/.test(block), `${name} still has ASSIGNMENT`);
  }
  assert.match(schema, /entity MOBI_DB_PO_S4_WORKFLOW\s*\{/);
});

console.log('PaymentCatalog');
check('type aliases normalize', () => {
  assert.strictEqual(PaymentCatalog.normalizeType('Withdrawal'), 'WITHDRAW');
  assert.strictEqual(PaymentCatalog.normalizeType('deposits'), 'DEPOSIT');
  assert.strictEqual(PaymentCatalog.normalizeType('PAYINS'), 'PAYIN');
});
check('sub type aliases normalize (case/space/underscore/slash insensitive)', () => {
  assert.strictEqual(PaymentCatalog.normalizeSubType('DEPOSIT', 'SELFTRANSFER'), 'Self Transfer');
  assert.strictEqual(PaymentCatalog.normalizeSubType('DEPOSIT', 'FXTOPUP'), 'FIAT FX TopUp');
  assert.strictEqual(PaymentCatalog.normalizeSubType('WITHDRAW', 'FIATSETTLEMENT'), 'Fiat Settlement');
  assert.strictEqual(PaymentCatalog.normalizeSubType('WITHDRAW', 'CANIS_SETTLEMENT'), 'Canis Settlement');
  assert.strictEqual(PaymentCatalog.normalizeSubType('DEPOSIT', 'Canis TopUp'), 'Canis TopUp');
});
check('host-independent flag', () => {
  assert.strictEqual(PaymentCatalog.isHostIndependentType('Deposit'), true);
  assert.strictEqual(PaymentCatalog.isHostIndependentType('Withdraw'), true);
  assert.strictEqual(PaymentCatalog.isHostIndependentType('PAYIN'), false);
});
check('validate rejects unknown sub type, passes legacy through', () => {
  assert.strictEqual(PaymentCatalog.validate('Withdraw', 'Bogus').valid, false);
  assert.strictEqual(PaymentCatalog.validate('Withdraw', 'Bogus').reason, 'UNKNOWN_SUBTYPE');
  assert.strictEqual(PaymentCatalog.validate('PAYIN', 'anything').valid, true);
});

console.log('NormalizeUtil');
check('canonical tokens + new payment codes', () => {
  assert.strictEqual(NormalizeUtil.paymentTypeToken('Withdrawal'), 'WITHDRAW');
  assert.strictEqual(NormalizeUtil.paymentSubTypeToken('DEPOSIT', 'FXTOPUP'), 'FIATFXTOPUP');
  assert.strictEqual(NormalizeUtil.paymentCode('Deposit'), 5);
  assert.strictEqual(NormalizeUtil.paymentCode('Withdraw'), 6);
  assert.strictEqual(NormalizeUtil.paymentCode('PAYIN'), 1);
});

console.log('ScenarioConfig');
check('DEPOSIT / WITHDRAW document types + cost centers + flags', () => {
  assert.strictEqual(ScenarioConfig.DEPOSIT.documentType, 'Z4');
  assert.strictEqual(ScenarioConfig.WITHDRAW.documentType, 'Z3');
  assert.deepStrictEqual(ScenarioConfig.DEPOSIT.costCenterByCompany, { 2000: '2018', 3000: '3018' });
  assert.deepStrictEqual(ScenarioConfig.WITHDRAW.costCenterByCompany, { 2000: '2017', 3000: '3017' });
  assert.strictEqual(ScenarioConfig.DEPOSIT.glIgnoreHost, true);
  assert.strictEqual(ScenarioConfig.DEPOSIT.glSubTypeFromRecord, true);
  assert.strictEqual(ScenarioConfig.DEPOSIT.requireHostCustomerNumber, false);
  assert.strictEqual(ScenarioConfig.DEPOSIT.requireMerchantBusinessPartner, true);
  assert.strictEqual(Builders.DEPOSIT, Builders.WITHDRAW);
});

console.log('GLAccountLookup (host-independent)');
const glRows = [
  { COMPANY_CODE: '2000', PAYMENT_TYPE: 'DEPOSIT', PAYMENT_SUB_TYPE: 'Canis TopUp', HOST_NAME: '', GL_Accounts: '80000004', Status: 'A', TXN_AMOUNT: 'X' },
  { COMPANY_CODE: '3000', PAYMENT_TYPE: 'WITHDRAW', PAYMENT_SUB_TYPE: 'Canis Settlement', HOST_NAME: '', GL_Accounts: '80000005', Status: 'A', TXN_AMOUNT: 'X' },
  { COMPANY_CODE: '2000', PAYMENT_TYPE: 'WITHDRAW', PAYMENT_SUB_TYPE: 'Fiat Settlement', HOST_NAME: '', GL_Accounts: '17000300', Status: 'A', TXN_AMOUNT: 'X' },
  // legacy DS row to prove backward compatibility
  { COMPANY_CODE: '2000', PAYMENT_TYPE: 'Domestic Settlement', PAYMENT_SUB_TYPE: 'DS', HOST_NAME: 'AMBANK', GL_Accounts: '17001000', Status: 'A', TXN_AMOUNT: 'X' }
];
const lookup = new GLAccountLookup(glRows);
check('matches regardless of host spelling and sub type alias', () => {
  const rec = { COMPANY_CODE: '2000', PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'CANISTOPUP', HOST_NAME: 'N/A', TXN_AMOUNT: 100 };
  assert.strictEqual(lookup.resolve(rec, 'TXN_AMOUNT', ScenarioConfig.DEPOSIT), '80000004');
});
check('per-sub type discrimination + missing GL', () => {
  const ok = { COMPANY_CODE: '2000', PAYMENT_TYPE: 'Withdrawal', PAYMENT_SUB_TYPE: 'FIATSETTLEMENT', HOST_NAME: 'ANY', TXN_AMOUNT: 100 };
  assert.strictEqual(lookup.resolve(ok, 'TXN_AMOUNT', ScenarioConfig.WITHDRAW), '17000300');
  const missing = { COMPANY_CODE: '2000', PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'Local Topup', HOST_NAME: 'N/A', TXN_AMOUNT: 100 };
  assert.strictEqual(lookup.resolve(missing, 'TXN_AMOUNT', ScenarioConfig.DEPOSIT), null);
  assert.deepStrictEqual(lookup.findMissingFields(missing, ScenarioConfig.DEPOSIT).missing, ['TXN_AMOUNT']);
});
check('legacy DOMESTIC SETTLEMENT lookup still resolves', () => {
  const rec = { COMPANY_CODE: '2000', PAYMENT_TYPE: 'DOMESTICSETTLEMENT', PAYMENT_SUB_TYPE: 'Domestic Settlement', HOST_NAME: 'AMBANK', TXN_AMOUNT: 100 };
  assert.strictEqual(lookup.resolve(rec, 'TXN_AMOUNT', ScenarioConfig.DOMESTIC_SETTLEMENT), '17001000');
});

console.log('DepositWithdrawConsolidationBuilder');
const baseRecord = {
  COMPANY_CODE: '2000', MOBI_PORTAL_CODE: '01', TXN_CURRENCY: 'IDR', TXN_AMOUNT: 150000.5,
  TXN_PAID_DATE: '2026-11-12', MERCHANT_ID: 'M123',
  HOST_REFERENCE_ID: 'HOST-REF-001', MERCHANT_REFERENCE_ID: 'MER-REF-001',
  HOST_NAME: 'N/A', MOBI_REFERENCE_ID: 'MOBI1'
};
let seq = 0;
const ctx = {
  referenceNumberService: { nextConsolRefId: async (s, c, d) => `${s.refToken}-${c}-${d}-${++seq}` },
  resolveGlAccount: () => '80000004',
  resolveMerchantBp: () => ({ bpNumber: '443217', externalBpNumber: 'M123' })
};
check('DEPOSIT -> Z4, Dr GL clearing (S) + Cr merchant AP (H), balanced, both references', async () => {
  const b = new Builders.DEPOSIT(ScenarioConfig.DEPOSIT);
  const rec = { ...baseRecord, PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'Canis TopUp' };
  const { documents, unbalanced } = await b.buildDocuments([rec], { postingDate: '2026-11-12', requestedBy: 'TEST' }, ctx);
  assert.strictEqual(unbalanced.length, 0);
  const d = documents[0];
  assert.strictEqual(b.isBalanced(d), true);
  assert.strictEqual(d.header.DOCUMENT_TYPE, 'Z4');
  assertReferences(d.header, 'HOST-REF-001', 'MER-REF-001');
  assert.strictEqual(d.lineItems.length, 2);
  assert.strictEqual(d.lineItems[0].DEBIT_CREDIT_INDICATOR, 'S');
  assert.strictEqual(d.lineItems[0].GL_ACCOUNT, '80000004');
  assert.strictEqual(d.lineItems[0].COST_CENTER, '2018');
  assert.strictEqual(d.lineItems[1].DEBIT_CREDIT_INDICATOR, 'H');
  assert.strictEqual(d.lineItems[1].SAP_SUPPLIER_NUMBER, '443217');
  assert.strictEqual(d.lineItems[1].COST_CENTER, null);
  d.lineItems.forEach((line) => assertReferences(line, 'HOST-REF-001', 'MER-REF-001'));
});
check('WITHDRAW -> Z3, Dr merchant AP (S) + Cr GL clearing (H), balanced, both references', async () => {
  const b = new Builders.WITHDRAW(ScenarioConfig.WITHDRAW);
  const rec = { ...baseRecord, COMPANY_CODE: '3000', PAYMENT_TYPE: 'Withdraw', PAYMENT_SUB_TYPE: 'Canis Settlement' };
  const { documents } = await b.buildDocuments([rec], { postingDate: '2026-11-12', requestedBy: 'TEST' }, ctx);
  const d = documents[0];
  assert.strictEqual(b.isBalanced(d), true);
  assert.strictEqual(d.header.DOCUMENT_TYPE, 'Z3');
  assertReferences(d.header, 'HOST-REF-001', 'MER-REF-001');
  assert.strictEqual(d.lineItems[0].DEBIT_CREDIT_INDICATOR, 'S');
  assert.strictEqual(d.lineItems[0].SAP_SUPPLIER_NUMBER, '443217');
  assert.strictEqual(d.lineItems[1].DEBIT_CREDIT_INDICATOR, 'H');
  assert.strictEqual(d.lineItems[1].GL_ACCOUNT, '80000004');
  assert.strictEqual(d.lineItems[1].COST_CENTER, '3017');
  d.lineItems.forEach((line) => assertReferences(line, 'HOST-REF-001', 'MER-REF-001'));
});
check('blank source references become null on header and lines', async () => {
  const b = new Builders.DEPOSIT(ScenarioConfig.DEPOSIT);
  const rec = { ...baseRecord, PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'Testing', HOST_REFERENCE_ID: '  ', MERCHANT_REFERENCE_ID: undefined };
  const { documents } = await b.buildDocuments([rec], { postingDate: '2026-11-12' }, ctx);
  const d = documents[0];
  assertReferences(d.header, null, null);
  d.lineItems.forEach((line) => assertReferences(line, null, null));
});

console.log('Reference persistence + reversal archive');
check('both references survive consolidation insert and reversal archive', async () => {
  const b = new Builders.DEPOSIT(ScenarioConfig.DEPOSIT);
  const rec = { ...baseRecord, PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'Canis TopUp' };
  const { documents } = await b.buildDocuments([rec], { postingDate: '2026-11-12', requestedBy: 'TEST' }, ctx);
  const doc = documents[0];

  // Capture what ConsolidationRepository actually inserts.
  const inserted = {};
  const originalConnect = cds.connect.to;
  cds.connect.to = async () => ({
    run: async (q) => { if (q.INSERT) inserted[insertEntity(q)] = insertEntries(q); }
  });
  try {
    await new ConsolidationRepository().insertDocuments([doc], 'audit-1');
  } finally {
    cds.connect.to = originalConnect;
  }
  const header = inserted['mobi.db.MOBI_DB_CONSOLIDATIONHEADER'][0];
  const lines = inserted['mobi.db.MOBI_DB_CONSOLIDATIONLINEITEM'];
  assertReferences(header, 'HOST-REF-001', 'MER-REF-001');
  lines.forEach((line) => assertReferences(line, 'HOST-REF-001', 'MER-REF-001'));

  // Fake CAP transaction: remember archived inserts, satisfy archive validation,
  // and report active rows deleted. This exercises the real archive column picks.
  const archived = {};
  const tx = {
    run: async (q) => {
      if (q.INSERT) { archived[insertEntity(q)] = insertEntries(q); return; }
      if (q.SELECT) {
        const entity = selectEntity(q);
        if (String(entity).endsWith('_REVERSAL')) return archived[entity] || [];
        return q.SELECT.one ? null : [];
      }
      if (q.DELETE) return 0;
    }
  };
  const group = { header, lines, transactions: [rec] };
  const result = await new ReversalRepository().archiveAndDelete(
    tx, group,
    { AccountingDocument: 'REV-1', ReversalReason: '0001', LastChangeDate: '2026-11-12' },
    'audit-rev'
  );
  assert.strictEqual(result.headerCount, 1);
  assert.strictEqual(result.lineItemCount, 2);
  const revHeader = archived['mobi.db.MOBI_DB_CONSOLIDATIONHEADER_REVERSAL'][0];
  const revLines = archived['mobi.db.MOBI_DB_CONSOLIDATIONLINEITEM_REVERSAL'];
  assertReferences(revHeader, 'HOST-REF-001', 'MER-REF-001');
  revLines.forEach((line) => assertReferences(line, 'HOST-REF-001', 'MER-REF-001'));
});

console.log('Ingestion validation');
const bv = new BusinessValidator();
check('BusinessValidator accepts new types/aliases, rejects bogus, legacy intact', () => {
  assert.strictEqual(bv.validate({ PAYMENT_TYPE: 'Deposit', PAYMENT_SUB_TYPE: 'Canis TopUp', TXN_STATUS: 'SUCCESS' }).valid, true);
  assert.strictEqual(bv.validate({ PAYMENT_TYPE: 'Withdrawal', PAYMENT_SUB_TYPE: 'FIATSETTLEMENT', TXN_STATUS: 'SUCCESS' }).valid, true);
  assert.strictEqual(bv.validate({ PAYMENT_TYPE: 'Withdraw', PAYMENT_SUB_TYPE: 'Nope', TXN_STATUS: 'SUCCESS' }).valid, false);
  assert.strictEqual(bv.validate({ PAYMENT_TYPE: 'FOO', PAYMENT_SUB_TYPE: 'BAR', TXN_STATUS: 'SUCCESS' }).valid, false);
  assert.strictEqual(bv.validate({ PAYMENT_TYPE: 'PAYIN', PAYMENT_SUB_TYPE: 'PAYIN', TXN_STATUS: 'SUCCESS' }).valid, true);
});
check('ValidationService skips host master check for Deposit, keeps it for PAYIN', () => {
  const vs = new ValidationService({});
  const index = {
    portalCodes: new Set(['MY']), portalCompanyKeys: new Set(['MY|2000']),
    merchants: new Map([['MY|2000|M1', { COUNTRY_CODE: 'MY' }]]), hosts: new Set()
  };
  const depErr = []; vs._validateMaster({ MOBI_PORTAL_CODE: 'MY', COMPANY_CODE: '2000', MERCHANT_ID: 'M1', HOST_NAME: 'N/A', PAYMENT_TYPE: 'Deposit' }, index, depErr);
  const payErr = []; vs._validateMaster({ MOBI_PORTAL_CODE: 'MY', COMPANY_CODE: '2000', MERCHANT_ID: 'M1', HOST_NAME: 'N/A', PAYMENT_TYPE: 'PAYIN' }, index, payErr);
  assert.strictEqual(depErr.length, 0);
  assert.strictEqual(payErr.length, 1);
});

// Await the async checks, then report.
(async () => {
  await Promise.all(pending);
  console.log(`\nAll ${passed} smoke checks passed.`);
})().catch((e) => { console.error('\nSMOKE TEST FAILED:', e); process.exit(1); });
