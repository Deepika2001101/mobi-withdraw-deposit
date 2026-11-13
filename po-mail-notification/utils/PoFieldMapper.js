'use strict';

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ONLY FILE YOU EDIT WHEN YOU PLUG IN YOUR PO CDS VIEW
 * ══════════════════════════════════════════════════════════════════════════
 *
 * For every field required by the mail, a list of *candidate* S/4HANA CDS
 * property names is tried in order and the first non-empty value wins.
 *
 * That means:
 *   • The CDS view name lives in PoConstants.ENTITY_PATH (already set)
 *   • Put your real property name FIRST in the candidate list
 *   • Nothing else changes — no template, no service, no handler.
 *
 * Every candidate list already contains the standard S/4HANA names
 * (I_PurchaseOrder / I_PurchaseOrderItem API style AND the Z* custom-CDS
 * style), so it works out of the box for the common cases.
 */

const { formatDate } = require('./PoDateUtil');
const Constants = require('../constants/PoConstants');

/** ── generic helpers ───────────────────────────────────────────────────── */

/** First non-empty value, trimmed. '' when all candidates are blank. */
function firstPresent(row, names) {
  if (!row || !Array.isArray(names)) return '';
  for (const name of names) {
    if (!name) continue;
    const value = row[name];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text && text.toLowerCase() !== 'null') return text;
  }
  return '';
}

/** First candidate that is a usable number, else 0. */
function firstNumber(row, names) {
  if (!row || !Array.isArray(names)) return 0;
  for (const name of names) {
    const raw = row?.[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const parsed = Number(String(raw).replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** First candidate that is a usable number, else null (preserves explicit 0). */
function firstNumberOrNull(row, names) {
  if (!row || !Array.isArray(names)) return null;
  for (const name of names) {
    const raw = row?.[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const parsed = Number(String(raw).replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Round to a currency/quantity scale without floating-point drift. */
function round(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** decimals;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

/** ── supplier tax number rules ───────────────────────────────────────────
 * Business rule (country-driven, value-free):
 *   • India      → Tax Number 3 (GSTIN)
 *   • any other  → Tax Number 1 (VAT / local tax id)
 *
 * Only field NAMES live here — never a tax number value. The whole rule is
 * configuration: override it per deployment WITHOUT code changes:
 *
 *   PO_TAX_FIELD_RULES='{"IN":["TaxNumber3"],"DEFAULT":["TaxNumber1"]}'
 *
 * Keys are upper-case ISO country codes; DEFAULT (or "*") covers every
 * country without its own entry. Unspecified keys fall back to the built-in
 * defaults below, and every branch ends with the legacy candidate names so
 * older/custom views (ZZ_*, STCD*, VAT…) keep working.
 */
const LEGACY_TAX_CANDIDATES = [
  'ZZ_SupplierGSTIN',
  'SupplierTaxNumber', 'VendorTaxNumber', 'TaxNumber', 'VATRegistration',
  'VatRegistrationNumber', 'GSTIN', 'SupplierVATNumber', 'TaxNumber1', 'STCEG'
];

const BUILTIN_TAX_FIELD_RULES = Object.freeze({
  IN: ['TaxNumber3', 'TaxNumber_3', 'SupplierTaxNumber3', 'STCD3', ...LEGACY_TAX_CANDIDATES],
  DEFAULT: ['TaxNumber1', 'TaxNumber_1', 'SupplierTaxNumber1', 'STCD1', ...LEGACY_TAX_CANDIDATES]
});

/** Field candidates for the SUPPLIER's country (never the company country). */
const SUPPLIER_COUNTRY_CANDIDATES = [
  'SupplierCountry', 'Country_1', 'SupplierCountryCode',
  'CountryCode', 'LAND1', 'Country'
];

let taxRulesCache = null;

/** Resolve the country→field rules once: PO_TAX_FIELD_RULES env, else built-in. */
function taxFieldRules() {
  if (taxRulesCache) return taxRulesCache;
  const raw = String(process.env.PO_TAX_FIELD_RULES || '').trim();
  if (!raw) {
    taxRulesCache = BUILTIN_TAX_FIELD_RULES;
    return taxRulesCache;
  }
  try {
    const parsed = JSON.parse(raw);
    const rules = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const names = value.filter((name) => typeof name === 'string' && name.trim());
      if (names.length) rules[String(key).trim().toUpperCase()] = names;
    }
    if (!Object.keys(rules).length) throw new Error('no country→field-array entries');
    if (!rules.DEFAULT && !rules['*']) rules.DEFAULT = BUILTIN_TAX_FIELD_RULES.DEFAULT;
    taxRulesCache = rules;
    console.log(`[PoFieldMapper] supplier tax rules from PO_TAX_FIELD_RULES: ${JSON.stringify(rules)}`);
  } catch (error) {
    console.warn(`[PoFieldMapper] PO_TAX_FIELD_RULES invalid, using built-in rules: ${error.message}`);
    taxRulesCache = BUILTIN_TAX_FIELD_RULES;
  }
  return taxRulesCache;
}

/**
 * Resolve the item array.
 * Supports both shapes a CDS view can produce:
 *   1. Header with a to_Item / Items navigation (needs $expand)
 *   2. One flat row per item (header fields repeated on every row)
 */
function resolveItemRows(header, itemsField) {
  if (Array.isArray(itemsField) && itemsField.length) return itemsField;
  if (!header) return [];

  const candidates = ['to_Item', 'Items', 'to_PurchaseOrderItem', 'POItems', 'items'];
  for (const name of candidates) {
    const value = header[name];
    if (Array.isArray(value) && value.length) return value;
    // OData V2 expand can nest results one level deeper
    if (Array.isArray(value?.results) && value.results.length) return value.results;
  }
  return [];
}

/** ── header mappers ────────────────────────────────────────────────────── */

const H = Object.freeze({
  // Identifiers used to group items + to key the "already mailed" log
  poNumber: (h) => firstPresent(h, ['PurchaseOrder', 'PONumber', 'PoNumber', 'PO_NUMBER', 'EBELN', 'PurchaseOrderNumber']),
  companyCode: (h) => firstPresent(h, ['CompanyCode', 'COMPANY_CODE', 'BUKRS', 'Company']),
  documentType: (h) => firstPresent(h, ['PurchaseOrderType', 'DocumentType', 'POType', 'DOC_TYPE', 'BSART', 'PoDocumentType']),
  creatorEmail: (h) => firstPresent(h, [
    Constants.CREATOR_EMAIL_FIELD,
    'CreatedByUserEmail', 'CreatorEmail', 'CreatedByEmail', 'CreatorEmailAddress'
  ]),

  // Supplier block
  supplierCode: (h) => firstPresent(h, ['Supplier', 'SupplierCode', 'VENDOR_CODE', 'LIFNR', 'SupplierId', 'SupplierNumber', 'PurchasingVendor']),
  supplierName: (h) => firstPresent(h, ['SupplierName', 'VendorName', 'SUPPLIER_NAME', 'SupplierFullName', 'CreatedByUser', 'LIFNR_Name']),
  /** Supplier address: only the CDS view's supplier region + country fields. */
  supplierAddress: (h) => [
    firstPresent(h, ['Region_1']),
    firstPresent(h, ['Country_1'])
  ].filter(Boolean).join(', '),
  /**
   * Supplier tax number — country-driven, no values ever hardcoded.
   * India (SupplierCountry/Country_1 = IN) reads Tax Number 3 (GSTIN);
   * every other country reads Tax Number 1. Field names only; the rule is
   * overridable via PO_TAX_FIELD_RULES (see BUILTIN_TAX_FIELD_RULES).
   */
  supplierTaxNumber: (h) => {
    const rules = taxFieldRules();
    const country = firstPresent(h, SUPPLIER_COUNTRY_CANDIDATES).toUpperCase();
    const list = (country && (rules[country] || rules['*'])) || rules.DEFAULT || BUILTIN_TAX_FIELD_RULES.DEFAULT;
    return firstPresent(h, list);
  },

  // Document / organisational data
  createdOn: (h) => formatDate(h.CreationDate || h.CreatedOn || h.CreatedDate || h.CreationDateTime || h.ERDAT || h.CreatedAt || h.PostingDate),
  createdBy: (h) => firstPresent(h, ['CreatedByUser', 'CreatedByName', 'CREATED_BY', 'CreatedBy', 'ERNAM', 'CreationUser']),
  purchasingOrganization: (h) => firstPresent(h, ['PurchasingOrganization', 'PURCH_ORG', 'EKORG', 'PurchOrg']),
  purchasingGroup: (h) => firstPresent(h, ['PurchasingGroup', 'PURCH_GROUP', 'EKGRP', 'PurchGroup']),
  currency: (h) => firstPresent(h, ['Currency', 'DocumentCurrency', 'TransactionCurrency', 'CURRENCY', 'WAERS', 'PoCurrency']) || 'INR',
  paymentTerms: (h) => firstPresent(h, [
    'ZZ_PaymentTermsText',
    'PaymentTermsText', 'PaymentTermsDescription', 'PAYMENT_TERMS_TEXT', 'PaymentTermsName',
    'PaymentTerms', 'ZTERM', 'IncotermsClassification'
  ]),
  headerText: (h) => firstPresent(h, [
    'ZZ_HeaderNote',
    'HeaderText', 'HeaderNote', 'POHeaderText', 'HEADER_TEXT', 'Memo', 'Remark', 'Remarks', 'PurchasingHeaderNote'
  ]),

  // S/4HANA workflow state supplied by the PO CDS view. Rejection must be
  // detected before interpreting a completed-task counter as an approval.
  completedWorkflowDialogTasks: (h) => firstNumberOrNull(h, ['NmbrOfCmpltdWrkflwDialogTasks']),
  activeWorkflowDialogTasks: (h) => firstNumberOrNull(h, ['NmbrOfActiveWrkflwDialogTasks']),
  purchasingProcessingStatus: (h) => firstPresent(h, [
    Constants.PROCESSING_STATUS_FIELD,
    'PurchasingProcessingStatus', 'PurchaseOrderProcessingStatus',
    'PurchasingDocumentProcessingStatus', 'PROCSTAT', 'PO_PROCESSING_STATUS'
  ]),
  isRejected: (h) => {
    const status = String(H.purchasingProcessingStatus(h) || '').trim().toUpperCase();
    return status ? Constants.REJECTED_STATUS_VALUES.includes(status) : false;
  },
  isActiveWorkflowStatus: (h) => {
    const status = String(H.purchasingProcessingStatus(h) || '').trim().toUpperCase();
    return status ? Constants.ACTIVE_WORKFLOW_STATUS_VALUES.includes(status) : false;
  },
  isFinalApprovedStatus: (h) => {
    const status = String(H.purchasingProcessingStatus(h) || '').trim().toUpperCase();
    return status ? Constants.FINAL_APPROVED_STATUS_VALUES.includes(status) : false;
  },

  // Totals (used when the CDS view does not deliver them — see PoMailService)
  totalBasePrice: (h) => firstNumber(h, ['TotalBasePrice', 'TotalNetAmount', 'NetOrderValue', 'TOTAL_BASE_PRICE', 'NetPriceAmount']),
  totalTax: (h) => firstNumber(h, ['TotalTax', 'TotalTaxAmount', 'TOTAL_TAX', 'TaxAmount']),
  totalAmount: (h) => firstNumber(h, ['TotalAmount', 'NetPOValue', 'TOTAL_AMOUNT', 'GrossAmount', 'TotalGrossAmount', 'OrderValue']),

  // Company block: only the CDS view's company region + country fields
  companyAddress: (h) => [
    firstPresent(h, ['Region']),
    firstPresent(h, ['Country'])
  ].filter(Boolean).join(', '),
  companyName: (h) => firstPresent(h, ['CompanyName', 'COMPANY_NAME', 'CompanyCodeName']),

  // Currency scales
  currencyDecimals: (h) => Number(firstPresent(h, ['CurrencyDecimals', 'CurrencyDecimal']) || 2),
  quantityDecimals: (h) => Number(firstPresent(h, ['QuantityDecimals', 'QuantityDecimal']) || 3)
});

/** ── item mappers ──────────────────────────────────────────────────────── */

const I = Object.freeze({
  slNo: (i, index) => {
    const value = firstPresent(i, ['ItemNumber', 'PurchaseOrderItem', 'Item', 'PO_ITEM', 'EBELP', 'LineItem', 'ItemNo']);
    if (!value) return String(index + 1);
    // SAP item numbers are 00010, 00020 -> show 1, 2, 3 as Sl. No.
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 10 && numeric % 10 === 0
      ? String(numeric / 10)
      : value;
  },
  itemCode: (i) => firstPresent(i, ['Item', 'PurchaseOrderItem', 'ItemNumber', 'EBELP', 'Material', 'MATERIAL', 'MATNR', 'MaterialNumber', 'Service']),
  description: (i) => {
    const direct = firstPresent(i, [
      'PurchaseOrderItemText', 'ItemDescription', 'ItemText', 'Description', 'ShortText', 'MaterialName',
      'PurchasingItemText', 'ITEM_TEXT', 'MAKTX', 'ServiceText', 'ItemName'
    ]);
    if (direct) return direct;
    // Fall back to "<material> (<material group text>)" when only codes arrive
    const material = firstPresent(i, ['Material', 'MATNR', 'MaterialNumber']);
    const group = firstPresent(i, ['MaterialGroupText', 'MaterialGroupName', 'ItemCategoryName', 'MaterialGroup']);
    return [material, group ? `(${group})` : ''].filter(Boolean).join(' ');
  },
  deliveryDate: (i) => formatDate(
    i.ScheduleLineDeliveryDate || i.DeliveryDate || i.ScheduledDeliveryDate || i.DeliveryDateTime || i.EEIND || i.PlannedDeliveryDate || i.MaterialDeliveryDate
  ),
  quantity: (i) => firstNumber(i, ['Quantity', 'OrderQuantity', 'POQuantity', 'RequestedQuantity', 'MENGE', 'TargetQuantity', 'ServiceQuantity']),
  quantityUnit: (i) => firstPresent(i, ['QuantityUnit', 'UnitOfMeasure', 'MEINS', 'PurchaseOrderQuantityUnit', 'BaseUnit', 'Unit']),
  unitPrice: (i) => firstNumber(i, ['UnitPrice', 'NetPrice', 'PricePerUnit', 'UNIT_PRICE', 'NetPriceAmount', 'Rate', 'GrossPrice']),
  priceUnit: (i) => firstNumber(i, ['PriceUnit', 'OrderPriceUnit', 'PEINH']) || 1,
  taxPercent: (i) => firstNumberOrNull(i, [
    'ConditionRateRatio', 'ZZ_TaxPercent', 'TaxPercent', 'TaxPercentage',
    'TAX_PERCENT', 'TaxRate', 'VATRate', 'GSTRate'
  ]),
  taxCode: (i) => firstPresent(i, ['TaxCode', 'TAX_CODE', 'MWSKZ', 'InputTaxCode', 'TaxJurisdiction']),
  basePrice: (i) => firstNumber(i, ['BasePrice', 'LineBasePrice', 'BASE_PRICE', 'NetValue', 'NetAmount', 'ItemNetAmount', 'LineNetAmount']),
  tax: (i) => firstNumber(i, ['Tax', 'TaxAmount', 'LineTax', 'TAX_AMOUNT', 'ItemTaxAmount', 'TaxValue']),
  total: (i) => firstNumber(i, ['Total', 'TotalAmount', 'LineTotal', 'TOTAL_AMOUNT', 'GrossAmount', 'ItemGrossAmount', 'LineGrossAmount']),
  plant: (i) => firstPresent(i, ['Plant', 'PLANT', 'WERKS'])
});

module.exports = {
  firstPresent,
  firstNumber,
  round,
  resolveItemRows,
  HEADER: H,
  ITEM: I
};