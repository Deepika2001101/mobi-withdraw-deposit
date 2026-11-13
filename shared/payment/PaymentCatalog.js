'use strict';

/**
 * PaymentCatalog — single source of truth for MOBI payment types / sub types.
 *
 * Why this file exists
 * --------------------
 * Deposit and Withdraw introduce ~19 free-text sub types that arrive from the
 * portals with inconsistent spellings ("Self Transfer" / "SELFTRANSFER",
 * "Fiat Settlement" / "FIATSETTLEMENT", "FIAT FX TopUp" / "FXTOPUP",
 * "Withdraw" / "Withdrawal"). Previously payment types were normalised with a
 * small numeric enum (PAYIN=1, PAYOUT=2, ...), which cannot express a catalogue
 * this large.
 *
 * This module is intentionally dependency-free (plain CommonJS, no CAP import)
 * so it can be required from:
 *   - txn-ingestion validators
 *   - consolidation NormalizeUtil / ScenarioConfig
 *   - srv/glaccount-service.js (GL value-lookup upload validation)
 *   - the node test suite
 *
 * Canonical values are the Sheet2 spellings from Book 19.xlsx.
 *
 * NOTE: company codes are deliberately NOT restricted per sub type. Sheet2 and
 * the sample transaction data contradict each other (e.g. "Canis TopUp" is
 * listed 3000-only but has 2000 rows), so both 2000 and 3000 are accepted for
 * every sub type. `companyCodes` below is documentation only.
 */

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Uppercase, strip every non-alphanumeric character. "Self Transfer" -> "SELFTRANSFER" */
function compact(value) {
  return String(value === undefined || value === null ? '' : value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Uppercase, collapse -/_/whitespace into single spaces. Keeps word boundaries. */
function words(value) {
  return String(value === undefined || value === null ? '' : value)
    .toUpperCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Payment TYPES
// ---------------------------------------------------------------------------

const PAYMENT_TYPES = Object.freeze({
  PAYIN: 'PAYIN',
  PAYOUT: 'PAYOUT',
  DEPOSIT: 'DEPOSIT',
  WITHDRAW: 'WITHDRAW'
});

/** compact(alias) -> canonical payment type */
const TYPE_ALIASES = Object.freeze({
  PAYIN: PAYMENT_TYPES.PAYIN,
  PAYINS: PAYMENT_TYPES.PAYIN,
  PAYOUT: PAYMENT_TYPES.PAYOUT,
  PAYOUTS: PAYMENT_TYPES.PAYOUT,
  DEPOSIT: PAYMENT_TYPES.DEPOSIT,
  DEPOSITS: PAYMENT_TYPES.DEPOSIT,
  WITHDRAW: PAYMENT_TYPES.WITHDRAW,
  WITHDRAWS: PAYMENT_TYPES.WITHDRAW,
  WITHDRAWAL: PAYMENT_TYPES.WITHDRAW,
  WITHDRAWALS: PAYMENT_TYPES.WITHDRAW
});

/** Raw spellings accepted in CSV / SQL IN clauses, per canonical type. */
const TYPE_RAW_ALIASES = Object.freeze({
  PAYIN: Object.freeze(['PAYIN', 'PAYINS', 'Payin', 'Payins', 'payin', 'payins']),
  PAYOUT: Object.freeze(['PAYOUT', 'PAYOUTS', 'Payout', 'Payouts', 'payout', 'payouts']),
  DEPOSIT: Object.freeze(['DEPOSIT', 'DEPOSITS', 'Deposit', 'Deposits', 'deposit', 'deposits']),
  WITHDRAW: Object.freeze([
    'WITHDRAW', 'WITHDRAWS', 'WITHDRAWAL', 'WITHDRAWALS',
    'Withdraw', 'Withdraws', 'Withdrawal', 'Withdrawals',
    'withdraw', 'withdraws', 'withdrawal', 'withdrawals'
  ])
});

// ---------------------------------------------------------------------------
// Payment SUB TYPES
// ---------------------------------------------------------------------------

/**
 * Each entry: canonical Sheet2 name + every compact alias seen in the workbook
 * or the portal feeds. `companyCodes` is informational only (see header note).
 */
const SUB_TYPES = Object.freeze({
  DEPOSIT: Object.freeze([
    { name: 'Advance - Weekend/PH Topup', companyCodes: ['2000', '3000'], aliases: ['ADVANCEWEEKENDPHTOPUP'] },
    { name: 'Balance Adjustment - MDR Mismatch', companyCodes: ['2000', '3000'], aliases: ['BALANCEADJUSTMENTMDRMISMATCH'] },
    { name: 'Balance Adjustment - Internal', companyCodes: ['3000'], aliases: ['BALANCEADJUSTMENTINTERNAL'] },
    { name: 'Canis TopUp', companyCodes: ['2000', '3000'], aliases: ['CANISTOPUP'] },
    { name: 'FIAT FX TopUp', companyCodes: ['2000', '3000'], aliases: ['FIATFXTOPUP', 'FXTOPUP', 'FIATFX'] },
    { name: 'Local Currency Topup', companyCodes: ['3000'], aliases: ['LOCALCURRENCYTOPUP'] },
    { name: 'Local Topup', companyCodes: ['2000'], aliases: ['LOCALTOPUP'] },
    {
      name: 'Topup for Payout to Domestic Merchant',
      companyCodes: ['2000'],
      aliases: ['TOPUPFORPAYOUTTODOMESTICMERCHANT']
    },
    { name: 'Self Transfer', companyCodes: ['2000', '3000'], aliases: ['SELFTRANSFER'] },
    { name: 'Testing', companyCodes: ['2000', '3000'], aliases: ['TESTING', 'TEST'] }
  ]),
  WITHDRAW: Object.freeze([
    { name: 'Balance Adjustment - MDR Mismatch', companyCodes: ['2000', '3000'], aliases: ['BALANCEADJUSTMENTMDRMISMATCH'] },
    { name: 'Balance Adjustment - Internal', companyCodes: ['3000'], aliases: ['BALANCEADJUSTMENTINTERNAL'] },
    { name: 'Canis Settlement', companyCodes: ['2000', '3000'], aliases: ['CANISSETTLEMENT'] },
    { name: 'Fiat Settlement', companyCodes: ['2000'], aliases: ['FIATSETTLEMENT'] },
    { name: 'Refund', companyCodes: ['2000', '3000'], aliases: ['REFUND', 'REFUNDS'] },
    { name: 'Testing', companyCodes: ['2000', '3000'], aliases: ['TESTING', 'TEST'] },
    { name: 'Transfers Between Portals', companyCodes: ['3000'], aliases: ['TRANSFERSBETWEENPORTALS'] },
    { name: 'Recovery - Weekend/PH Topup', companyCodes: ['3000'], aliases: ['RECOVERYWEEKENDPHTOPUP'] },
    // Present in the sample journal entries (Withdraw / SELFTRANSFER) even
    // though Sheet2 lists Self Transfer under Deposit only.
    { name: 'Self Transfer', companyCodes: ['2000', '3000'], aliases: ['SELFTRANSFER'] }
  ])
});

/** compact(alias|canonical) -> { type, name } */
const SUB_TYPE_INDEX = (() => {
  const index = new Map();
  for (const [type, entries] of Object.entries(SUB_TYPES)) {
    for (const entry of entries) {
      const keys = [entry.name, ...(entry.aliases || [])];
      for (const k of keys) {
        const c = compact(k);
        if (c) index.set(`${type}|${c}`, { type, name: entry.name });
      }
    }
  }
  return index;
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Canonical payment type for any raw spelling, or '' when unknown. */
function normalizeType(value) {
  return TYPE_ALIASES[compact(value)] || '';
}

/** True for the two new host-independent payment types. */
function isHostIndependentType(value) {
  const t = normalizeType(value);
  return t === PAYMENT_TYPES.DEPOSIT || t === PAYMENT_TYPES.WITHDRAW;
}

/**
 * Canonical sub type name for a raw value within a payment type, or ''.
 * Matching ignores case, spaces, hyphens, underscores and slashes.
 */
function normalizeSubType(type, value) {
  const t = normalizeType(type);
  if (!t) return '';
  const hit = SUB_TYPE_INDEX.get(`${t}|${compact(value)}`);
  return hit ? hit.name : '';
}

/** Canonical sub type names valid for a payment type (Sheet2 order). */
function subTypesFor(type) {
  const t = normalizeType(type);
  return (SUB_TYPES[t] || []).map((e) => e.name);
}

/**
 * Every raw sub-type spelling to accept in a SQL `IN (...)` clause for a type.
 * Includes canonical, uppercase, lowercase and all registered compact aliases.
 */
function subTypeSqlAliases(type) {
  const t = normalizeType(type);
  const entries = SUB_TYPES[t] || [];
  const out = new Set();
  for (const e of entries) {
    for (const v of [e.name, ...(e.aliases || [])]) {
      const raw = String(v).trim();
      if (!raw) continue;
      out.add(raw);
      out.add(raw.toUpperCase());
      out.add(raw.toLowerCase());
    }
  }
  return [...out];
}

/** Raw payment-type spellings for a SQL `IN (...)` clause. */
function typeSqlAliases(type) {
  return [...(TYPE_RAW_ALIASES[normalizeType(type)] || [])];
}

/**
 * Validate a type/sub-type pair.
 * Returns { valid, type, subType, reason } — reason is one of
 * 'UNKNOWN_TYPE' | 'UNKNOWN_SUBTYPE' | ''.
 */
function validate(type, subType) {
  const t = normalizeType(type);
  if (!t) return { valid: false, type: '', subType: '', reason: 'UNKNOWN_TYPE' };

  // Payin / Payout keep their legacy sub-type rules; this catalogue only
  // governs the new Deposit / Withdraw types.
  if (t === PAYMENT_TYPES.PAYIN || t === PAYMENT_TYPES.PAYOUT) {
    return { valid: true, type: t, subType: String(subType || '').trim(), reason: '' };
  }

  const st = normalizeSubType(t, subType);
  if (!st) return { valid: false, type: t, subType: '', reason: 'UNKNOWN_SUBTYPE' };
  return { valid: true, type: t, subType: st, reason: '' };
}

module.exports = {
  PAYMENT_TYPES,
  SUB_TYPES,
  compact,
  words,
  normalizeType,
  normalizeSubType,
  isHostIndependentType,
  subTypesFor,
  subTypeSqlAliases,
  typeSqlAliases,
  validate
};
