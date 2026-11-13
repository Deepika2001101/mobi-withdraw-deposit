'use strict';

/**
 * Date helpers for the PO mail notification flow.
 *
 * SAP returns dates in several shapes depending on the service flavour:
 *   OData V2  "/Date(1728950400000)/"
 *   OData V4  "2026-10-15" or "2026-10-15T11:36:53Z"
 *   CDS/RAP   "20261015" (DATS) or a Timestamp
 *
 * Everything is normalised through parseSapDate() and rendered with
 * formatDate() (dd.MM.yyyy, the SAP house format) so the mail always looks
 * the same whatever the underlying CDS view exposes.
 */

const DEFAULT_TIME_ZONE = process.env.PO_MAIL_TIME_ZONE || 'Asia/Calcutta';

/** True for null / undefined / '' / '0000-00-00' / '00000000' / 'null'. */
function isBlankDate(value) {
  if (value === null || value === undefined) return true;
  const text = String(value).trim();
  return text === '' || /^0+$/.test(text.replace(/\D/g, '')) || /^0{4}[-.]?0{2}[-.]?0{2}/.test(text)
    || text.toLowerCase() === 'null';
}

/**
 * Parse any SAP date representation into a JS Date (UTC-based, date only for
 * pure dates). Returns null when the value is empty or unparseable.
 */
function parseSapDate(value) {
  if (isBlankDate(value)) return null;

  // "/Date(1728950400000)/" and "/Date(1728950400000+0530)/"
  const epoch = /^\/?Date\((-?\d+)([+-]\d{4})?\)\/?$/i.exec(String(value).trim());
  if (epoch) {
    const date = new Date(Number(epoch[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();

  // "20261015"
  if (/^\d{8}$/.test(text)) {
    const date = new Date(Date.UTC(+text.slice(0, 4), +text.slice(4, 6) - 1, +text.slice(6, 8)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Already a Date / Timestamp instance
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // "2026-10-15", "2026-10-15T11:36:53Z", "2026-10-15 11:36:53"
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (iso) {
    const date = /[T ]/.test(text)
      ? new Date(text.replace(' ', 'T').endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(text)
        ? text.replace(' ', 'T')
        : `${text.replace(' ', 'T')}Z`)
      : new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** dd.MM.yyyy in the configured time zone (SAP house format). */
function formatDate(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = parseSapDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric'
  }).format(date).replace(/\//g, '.');
}

/** dd.MM.yyyy HH:mm:ss in the configured time zone. */
function formatDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = parseSapDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, { type, value: v }) => ({ ...acc, [type]: v }), {});
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** "15 Oct 2026, 17:36 IST" — used for the mail run stamp. */
function formatRunStamp(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short'
  }).format(now);
}

/** ISO date (yyyy-mm-dd) for a Date, in the configured time zone. */
function isoDateInZone(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
}

/** Start of today (00:00:00) in the configured time zone, as a Date. */
function startOfToday(timeZone = DEFAULT_TIME_ZONE) {
  const [y, m, d] = isoDateInZone(new Date(), timeZone).split('-').map(Number);
  // Built in UTC so the value is stable regardless of the CF container TZ.
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
}

/** now - days, floored to the start of that day in the configured time zone. */
function daysAgoStart(days, timeZone = DEFAULT_TIME_ZONE) {
  const safeDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 1;
  const base = startOfToday(timeZone);
  return new Date(base.getTime() - (safeDays - 1) * 86400000);
}

/** OData V2 Edm.DateTime literal (timezone-less): datetime'2026-10-15T00:00:00' */
function toV2Literal(date) {
  return date.toISOString().replace('Z', '').replace(/\.\d{3}$/, '');
}

/** OData V4 Edm.DateTimeOffset literal: 2026-10-15T00:00:00Z */
function toV4Literal(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

module.exports = {
  DEFAULT_TIME_ZONE,
  isBlankDate,
  parseSapDate,
  formatDate,
  formatDateTime,
  formatRunStamp,
  isoDateInZone,
  startOfToday,
  daysAgoStart,
  toV2Literal,
  toV4Literal
};