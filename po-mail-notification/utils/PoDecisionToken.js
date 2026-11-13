'use strict';

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Signed, expiring, single-use decision links for the mail buttons
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The Approve / Reject buttons in the approval mail point to
 *   {PUBLIC_URL}/po-mail/decision?t=<token>
 * The token is an HMAC-SHA256 signed payload:
 *   { p: poNumber, c: companyCode, d: documentType, l: level, a: action,
 *     i: issuedEpoch, e: expiryEpoch }
 *
 * Security model (two-step, scanner-proof):
 *   • GET  /po-mail/decision          -> only SHOWS a confirmation page
 *   • POST /po-mail/decision/confirm  -> actually applies the decision
 * Mail link scanners (SafeLinks etc.) only ever issue GETs, so they can never
 * approve or reject a PO. The POST is additionally single-use per level
 * (PoApprovalRepository) and expires after DECISION_TOKEN_HOURS.
 */

const crypto = require('crypto');
const Constants = require('../constants/PoConstants');

let bootSecret = null;

function secret() {
  if (Constants.DECISION_TOKEN_SECRET) return Constants.DECISION_TOKEN_SECRET;
  if (!bootSecret) {
    bootSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[PoDecisionToken] PO_MAIL_TOKEN_SECRET is not set - using a random boot secret. ' +
      'Decision links will stop working after a restart. Set a fixed secret in production!'
    );
  }
  return bootSecret;
}

const sign = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

/**
 * Create a token.
 * @param {object} payload { poNumber, companyCode, documentType, level, action }
 * @param {number} [hoursOverride] test hook: lifetime in hours (may be negative = expired)
 */
function issue({ poNumber, companyCode, documentType, level, action, recipients = [], approvalFlow = [] }, hoursOverride) {
  const hours = hoursOverride === undefined ? Constants.DECISION_TOKEN_HOURS : hoursOverride;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    p: poNumber || '',
    c: companyCode || '',
    d: documentType || '',
    l: Number(level) || 1,
    a: action === 'reject' ? 'reject' : 'approve',
    r: Array.isArray(recipients) ? recipients.map((email) => String(email).trim().toLowerCase()).filter(Boolean) : [],
    f: Array.isArray(approvalFlow) ? approvalFlow.map((entry) => ({
      l: Number(entry?.level) || 0,
      r: Array.isArray(entry?.recipients) ? entry.recipients.map((email) => String(email).trim().toLowerCase()).filter(Boolean) : []
    })).filter((entry) => entry.l > 0) : [],
    i: now,
    e: now + Math.round(hours * 3600)
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Verify signature + expiry. Never throws. */
function verify(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing link token' };
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return { ok: false, reason: 'malformed link token' };

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'link signature invalid (tampered or wrong secret)' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (error) {
    return { ok: false, reason: 'link payload unreadable' };
  }
  if (!payload || typeof payload.e !== 'number') return { ok: false, reason: 'link payload incomplete' };
  if (payload.e < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'link expired', payload };
  return { ok: true, payload };
}

module.exports = { issue, verify };