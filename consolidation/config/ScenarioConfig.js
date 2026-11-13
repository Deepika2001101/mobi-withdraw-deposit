'use strict';

const Constants = require('../constants/ConsolidationConstants');
const PaymentCatalog = require('../../shared/payment/PaymentCatalog');

const RETRYABLE_STATUSES = Constants.PENDING_CONSOL_STATUSES.slice();

const aliases = (...values) => {
  const result = new Set();
  for (const v of values.flat()) {
    const t = String(v || '').trim();
    if (!t) continue;
    result.add(t);
    result.add(t.toUpperCase());
    result.add(t.toLowerCase());
  }
  return [...result];
};

const PAYIN_TYPE_ALIASES = aliases('PAYIN', 'PAYINS', 'Payin', 'Payins');
const PAYOUT_TYPE_ALIASES = aliases('PAYOUT', 'PAYOUTS', 'Payout', 'Payouts');
const PAYOUT_SUBTYPE_ALIASES = aliases('NORMAL', 'Normal');
const DS_SUBTYPE_ALIASES = aliases(
  'DOMESTIC SETTLEMENT', 'Domestic Settlement', 'domestic settlement',
  'DOMESTIC_SETTLEMENT', 'Domestic_Settlement',
  'DOMESTICSETTLEMENT', 'DomesticSettlement', 'DS'
);

// Deposit / Withdraw (Book 19.xlsx). Raw spellings accepted in SQL IN clauses
// come from the shared catalog so ingestion, consolidation and GL lookup agree.
const DEPOSIT_TYPE_ALIASES = aliases(PaymentCatalog.typeSqlAliases('DEPOSIT'));
const WITHDRAW_TYPE_ALIASES = aliases(PaymentCatalog.typeSqlAliases('WITHDRAW'));
const DEPOSIT_SUBTYPE_ALIASES = aliases(PaymentCatalog.subTypeSqlAliases('DEPOSIT'));
const WITHDRAW_SUBTYPE_ALIASES = aliases(PaymentCatalog.subTypeSqlAliases('WITHDRAW'));

module.exports = Object.freeze({
  PAYIN: {
    code: 'PAYIN',
    displayName: 'Payin',
    systemUser: Constants.SYSTEM_USERS.PAYIN,
    paymentTypeAliases: PAYIN_TYPE_ALIASES,
    paymentSubTypeAliases: PAYIN_TYPE_ALIASES,
    outputPaymentType: 'PAYINS',
    outputPaymentSubType: 'PAYINS',
    allowedCompanyCodes: ['2000', '3000'],
    retryableConsolStatuses: RETRYABLE_STATUSES,
    groupMode: Constants.GROUP_MODE.DAILY,
    refToken: 'PAYIN',
    documentType: 'Z1',
    costCenterByCompany: { '2000': '2014', '3000': '3014' },
    profitCenterByCompany: { '2000': '2000', '3000': '3000' },
    postingStatus: Constants.POSTING_STATUS.CONSOLIDATION_PENDING,
    requireMerchantBusinessPartner: true,
    requireHostCustomerNumber: true,
    requiredGlAccountFields: [
      { glFlagField: 'HOST_MDR_AMOUNT', amountField: 'HOST_MDR_AMOUNT' },
      { glFlagField: 'MDR_REVENUE', amountField: 'MDR_REVENUE' }
    ]
  },

  PAYOUT: {
    code: 'PAYOUT',
    displayName: 'Payout',
    systemUser: Constants.SYSTEM_USERS.PAYOUT,
    paymentTypeAliases: PAYOUT_TYPE_ALIASES,
    paymentSubTypeAliases: PAYOUT_SUBTYPE_ALIASES,
    outputPaymentType: 'PAYOUT',
    outputPaymentSubType: 'NORMAL',
    allowedCompanyCodes: ['2000', '3000'],
    retryableConsolStatuses: RETRYABLE_STATUSES,
    groupMode: Constants.GROUP_MODE.DAILY,
    refToken: 'PAYOUT',
    documentType: 'Z2',
    costCenterByCompany: { '2000': '2015', '3000': '3015' },
    profitCenterByCompany: { '2000': '2000', '3000': '3000' },
    postingStatus: Constants.POSTING_STATUS.CONSOLIDATION_PENDING,
    requireMerchantBusinessPartner: true,
    requireHostCustomerNumber: true,
    glPaymentSubTypeAliases: PAYOUT_SUBTYPE_ALIASES,
    requiredGlAccountFields: [
      { glFlagField: 'HOST_MDR_AMOUNT', amountField: 'HOST_MDR_AMOUNT' },
      { glFlagField: 'MDR_REVENUE', amountField: 'MDR_REVENUE' },
      { glFlagField: 'TXN_AMOUNT', amountField: 'TXN_AMOUNT' },
      { glFlagField: 'HOST_FEE_PAYABLE', amountField: 'HOST_FEE_PAYABLE', fallbackAmountField: 'HOST_MDR_AMOUNT' }
    ],
    lineBlockOrder: ['HOST_COST', 'HOST_MDR_REVENUE', 'CLEAR_PAYOUT', 'MERCHANT_AP_PAYOUT', 'HOST_FEE_PAYABLE']
  },

  DOMESTIC_SETTLEMENT: {
  code: 'DOMESTIC_SETTLEMENT',
  displayName: 'Domestic Settlement',
  systemUser: Constants.SYSTEM_USERS.DOMESTIC_SETTLEMENT,

  paymentTypeAliases: PAYOUT_TYPE_ALIASES,
  paymentSubTypeAliases: DS_SUBTYPE_ALIASES,

  outputPaymentType: 'PAYOUT',
  outputPaymentSubType: 'DOMESTIC SETTLEMENT',

  allowedCompanyCodes: ['2000'],
  retryableConsolStatuses: RETRYABLE_STATUSES,

  // New logic creates one document per company / portal / posting date / currency.
  groupMode: Constants.GROUP_MODE.DAILY,

  // To match sample CONSOL_REF_ID: 2000PAYOUTDS202606290001
  refToken: 'DOMESTICSETTLEMENT',

  // To match sample SAP_REF_DOCUMENT: 10000001
  // Remove this if SAP reference document should remain blank until CPI/SAP returns it.
  sapReferencePrefix: '1',

  documentType: 'Z5',

  costCenterByCompany: {
    '2000': '2016'
  },
  profitCenterByCompany: {
    '2000': '2000'
  },

  postingStatus: Constants.POSTING_STATUS.CONSOLIDATION_PENDING,

  requireMerchantBusinessPartner: true,

  // Now required because host lines contain SAP_CUSTOMER_NUMBER.
  requireHostCustomerNumber: true,

  // Settlement amount used for merchant payout lines and clearing debit.
  // CHANGED: merchant lines now source their amount STRICTLY from TXN_AMOUNT
  // (no AP_PAYOUT fallback). Item change: AP_PAYOUT -> TXN_AMOUNT.
  amountField: 'TXN_AMOUNT',

  // Internal amount field used for the clearing debit line.
  // CHANGED: AP_PAYOUT carries the debit (S) "total" line per requirement.
  clearingAmountField: 'AP_PAYOUT',
  clearingGlFlagField: 'TXN_AMOUNT',

  // Amount field used for the merchant credit line.
  // CHANGED: TRANSACTION_AMOUNT carries the credit (H) "merchant supplier"
  // line per requirement.
  merchantAmountField: 'TRANSACTION_AMOUNT',

  // New line order to match your sample.
  domesticLineBlockOrder: [
    'CLEARING_DEBIT',
    'HOST_COST_DEBIT',
    'MERCHANT_AP_PAYOUT_CREDIT',
    'HOST_FEE_PAYABLE_CREDIT'
  ],

  requiredGlAccountFields: [
    {
      // Clearing debit GL, example: 17001000
      glFlagField: 'TXN_AMOUNT',
      amountField: 'TXN_AMOUNT'
    },
    {
      // Host MDR debit GL, example: 41001400
      glFlagField: 'HOST_MDR_AMOUNT',
      amountField: 'HOST_MDR_AMOUNT'
    },
    {
      // Host fee payable credit GL, example: 15002200
      glFlagField: 'HOST_FEE_PAYABLE',
      amountField: 'HOST_FEE_PAYABLE',
      fallbackAmountField: 'HOST_MDR_AMOUNT'
    }
  ]
},

  // ---------------------------------------------------------------------------
  // DEPOSIT (Book 19.xlsx) — one Z4 document per transaction.
  //   Line 1: GL clearing  DEBIT (S)  transaction_amount, cost center, GL lookup
  //   Line 2: Merchant AP  CREDIT (H) transaction_amount, SAP supplier number
  // Host-independent: GL keyed by company + type + sub type (no host).
  // ---------------------------------------------------------------------------
  DEPOSIT: {
    code: 'DEPOSIT',
    displayName: 'Deposit',
    systemUser: Constants.SYSTEM_USERS.DEPOSIT,
    paymentTypeAliases: DEPOSIT_TYPE_ALIASES,
    paymentSubTypeAliases: DEPOSIT_SUBTYPE_ALIASES,
    outputPaymentType: 'DEPOSIT',
    // outputPaymentSubType intentionally omitted -> builder keeps the
    // transaction's own (canonical) sub type on the header / line items.
    allowedCompanyCodes: ['2000', '3000'],
    retryableConsolStatuses: RETRYABLE_STATUSES,
    groupMode: Constants.GROUP_MODE.PER_TRANSACTION,
    refToken: 'DEPOSIT',
    documentType: 'Z4',
    costCenterByCompany: { '2000': '2018', '3000': '3018' },
    profitCenterByCompany: { '2000': '2000', '3000': '3000' },
    postingStatus: Constants.POSTING_STATUS.CONSOLIDATION_PENDING,
    requireMerchantBusinessPartner: true,
    requireHostCustomerNumber: false,
    // GL matching rules for the new host-independent types:
    glIgnoreHost: true,
    glSubTypeFromRecord: true,
    subTypeMatchNormalized: true,
    requiredGlAccountFields: [
      { glFlagField: 'TXN_AMOUNT', amountField: 'TXN_AMOUNT' }
    ]
  },

  // ---------------------------------------------------------------------------
  // WITHDRAW (Book 19.xlsx) — one Z3 document per transaction.
  //   Line 1: Merchant AP  DEBIT (S)  transaction_amount, SAP supplier number
  //   Line 2: GL clearing  CREDIT (H) transaction_amount, cost center, GL lookup
  // ---------------------------------------------------------------------------
  WITHDRAW: {
    code: 'WITHDRAW',
    displayName: 'Withdraw',
    systemUser: Constants.SYSTEM_USERS.WITHDRAW,
    paymentTypeAliases: WITHDRAW_TYPE_ALIASES,
    paymentSubTypeAliases: WITHDRAW_SUBTYPE_ALIASES,
    outputPaymentType: 'WITHDRAW',
    allowedCompanyCodes: ['2000', '3000'],
    retryableConsolStatuses: RETRYABLE_STATUSES,
    groupMode: Constants.GROUP_MODE.PER_TRANSACTION,
    refToken: 'WITHDRAW',
    documentType: 'Z3',
    costCenterByCompany: { '2000': '2017', '3000': '3017' },
    profitCenterByCompany: { '2000': '2000', '3000': '3000' },
    postingStatus: Constants.POSTING_STATUS.CONSOLIDATION_PENDING,
    requireMerchantBusinessPartner: true,
    requireHostCustomerNumber: false,
    glIgnoreHost: true,
    glSubTypeFromRecord: true,
    subTypeMatchNormalized: true,
    requiredGlAccountFields: [
      { glFlagField: 'TXN_AMOUNT', amountField: 'TXN_AMOUNT' }
    ]
  }
});
