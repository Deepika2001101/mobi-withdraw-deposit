'use strict';

/**
 * Amount formatting + "Total Amount in Words".
 *
 * INR (and a few neighbours) are spelled out in the Indian system
 * (…lakh, crore); every other currency uses the international system
 * (…million, billion). Override with PO_MAIL_NUMBER_SYSTEM = IN | INTL.
 */

const ONES = Object.freeze([
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'
]);
const TENS = Object.freeze([
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'
]);

/** Currencies spelled out in the Indian numbering system. */
const INDIAN_CURRENCIES = Object.freeze(['INR', 'NPR', 'BDT', 'PKR', 'LKR', 'MVR']);

const FORCED_SYSTEM = (process.env.PO_MAIL_NUMBER_SYSTEM || '').toUpperCase(); // 'IN' | 'INTL' | ''

/** Currencies whose minor unit is not "paise/cents" — extend as needed. */
const SUBUNIT_LABELS = Object.freeze({
  INR: ['Rupees', 'Paise'],
  NPR: ['Rupees', 'Paise'],
  LKR: ['Rupees', 'Cents'],
  PKR: ['Rupees', 'Paise'],
  BDT: ['Taka', 'Poisha'],
  MVR: ['Rufiyaa', 'Laari'],
  USD: ['Dollars', 'Cents'],
  EUR: ['Euros', 'Cents'],
  GBP: ['Pounds', 'Pence'],
  AED: ['Dirhams', 'Fils'],
  SAR: ['Riyals', 'Halalas'],
  SGD: ['Dollars', 'Cents'],
  MYR: ['Ringgit', 'Sens'],
  IDR: ['Rupiah', 'Sen'],
  JPY: ['Yen', ''],
  KRW: ['Won', '']
});

function isIndianSystem(currency) {
  if (FORCED_SYSTEM === 'IN') return true;
  if (FORCED_SYSTEM === 'INTL') return false;
  return INDIAN_CURRENCIES.includes(String(currency || '').trim().toUpperCase());
}

function labelsFor(currency) {
  const code = String(currency || '').trim().toUpperCase();
  return SUBUNIT_LABELS[code] || [code || 'Amount', 'Cents'];
}

/** 0..999 -> words. */
function belowThousand(value) {
  const parts = [];
  let rest = value;
  if (rest >= 100) {
    parts.push(`${ONES[Math.floor(rest / 100)]} Hundred`);
    rest %= 100;
  }
  if (rest >= 20) {
    parts.push(TENS[Math.floor(rest / 10)]);
    rest %= 10;
  }
  if (rest > 0) parts.push(ONES[rest]);
  return parts.filter(Boolean).join(' ');
}

/** Integer -> words, Indian system (crore / lakh / thousand). */
function indianWords(integer) {
  if (integer === 0) return 'Zero';
  const groups = [
    { size: 10000000, label: 'Crore' },
    { size: 100000, label: 'Lakh' },
    { size: 1000, label: 'Thousand' },
    { size: 1, label: '' }
  ];
  const parts = [];
  let rest = integer;
  for (const group of groups) {
    const count = Math.floor(rest / group.size);
    if (count > 0) {
      parts.push(group.label ? `${belowThousand(count)} ${group.label}` : belowThousand(count));
      rest %= group.size;
    }
  }
  return parts.filter(Boolean).join(' ');
}

/** Integer -> words, international system (billion / million / thousand). */
function internationalWords(integer) {
  if (integer === 0) return 'Zero';
  const groups = [
    { size: 1e9, label: 'Billion' },
    { size: 1e6, label: 'Million' },
    { size: 1000, label: 'Thousand' },
    { size: 1, label: '' }
  ];
  const parts = [];
  let rest = integer;
  for (const group of groups) {
    const count = Math.floor(rest / group.size);
    if (count > 0) {
      parts.push(group.label ? `${belowThousand(count)} ${group.label}` : belowThousand(count));
      rest %= group.size;
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * "Rupees One Lakh Twenty Five Thousand Three Hundred Forty Five and Paise Sixty Only"
 */
function amountInWords(amount, currency = 'INR') {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  if (value < 0) return `Minus ${amountInWords(-value, currency)}`;

  const [majorLabel, minorLabel] = labelsFor(currency);
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  const integer = Math.floor(rounded);
  const fraction = Math.round((rounded - integer) * 100);

  const spell = isIndianSystem(currency) ? indianWords : internationalWords;
  const majorPart = `${majorLabel} ${spell(integer)}`;
  const minorPart = fraction > 0 && minorLabel ? ` and ${minorLabel} ${spell(fraction)}` : '';
  return `${majorPart}${minorPart} Only`;
}

/** Locale-grouped amount, e.g. 1,25,345.60 (INR) / 125,345.60 (USD). */
function formatAmount(value, currency = 'INR', decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  const locale = isIndianSystem(currency) ? 'en-IN' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(parsed);
  } catch (_) {
    return parsed.toFixed(decimals);
  }
}

/** "INR 1,25,345.60" — the form used inside the mail tables. */
function formatMoney(value, currency = 'INR', decimals = 2) {
  const amount = formatAmount(value, currency, decimals);
  return amount ? `${String(currency || '').trim().toUpperCase()} ${amount}` : '';
}

/** Quantity, e.g. "10.000 EA". */
function formatQuantity(value, unit = '', decimals = 3) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(parsed);
  return unit ? `${text} ${unit}` : text;
}

/** Tax percent, e.g. "18%" (18 / 18.0 / 18.00 all render as 18%). */
function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '';
  const rounded = Math.round((parsed + Number.EPSILON) * 1000) / 1000;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : String(rounded)}%`;
}

module.exports = {
  amountInWords,
  formatAmount,
  formatMoney,
  formatQuantity,
  formatPercent,
  isIndianSystem
};