'use strict';

/** Verify the Microsoft-signed bearer token on an Outlook Action.Http POST. */
const crypto = require('crypto');
const Constants = require('../constants/PoConstants');

const OPENID_URL = 'https://substrate.office.com/sts/common/.well-known/openid-configuration';
const EXPECTED_ISSUER = 'https://substrate.office.com/sts/';
let jwksCache = { expiresAt: 0, keys: [] };
let jwksInFlight = null;

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function loadKeys(force = false) {
  if (!force && jwksCache.expiresAt > Date.now() && jwksCache.keys.length) return jwksCache.keys;
  if (jwksInFlight) return jwksInFlight;
  jwksInFlight = (async () => {
    const metadataResponse = await fetch(OPENID_URL, { signal: AbortSignal.timeout(8000) });
    if (!metadataResponse.ok) throw new Error(`Microsoft OpenID metadata returned HTTP ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    if (!metadata?.jwks_uri) throw new Error('Microsoft OpenID metadata has no jwks_uri');
    const keyResponse = await fetch(metadata.jwks_uri, { signal: AbortSignal.timeout(8000) });
    if (!keyResponse.ok) throw new Error(`Microsoft signing-key endpoint returned HTTP ${keyResponse.status}`);
    const document = await keyResponse.json();
    const keys = Array.isArray(document.keys) ? document.keys : [];
    if (!keys.length) throw new Error('Microsoft signing-key document is empty');
    jwksCache = { keys, expiresAt: Date.now() + 60 * 60 * 1000 };
    return keys;
  })();
  try {
    return await jwksInFlight;
  } finally {
    jwksInFlight = null;
  }
}

function getBearer(req) {
  const authorization = req.headers?.authorization || req.headers?.['action-authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
  return match?.[1] || '';
}

/** @returns {Promise<{ok:boolean, actor?:string, reason?:string}>} */
async function verifyRequest(req, recipients = []) {
  try {
    const token = getBearer(req);
    if (!token) return { ok: false, reason: 'Missing Microsoft Actionable Messages bearer token.' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'Malformed Microsoft bearer token.' };
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodePart(encodedHeader);
    const claims = decodePart(encodedPayload);
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'Unsupported Microsoft token signature.' };

    const expectedAudience = Constants.ACTIONABLE_AUDIENCE || new URL(Constants.PUBLIC_URL).origin;
    if (claims.iss !== EXPECTED_ISSUER) return { ok: false, reason: 'Unexpected Microsoft token issuer.' };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expectedAudience)) return { ok: false, reason: 'Microsoft token audience does not match this CAP service.' };
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now || (claims.nbf && claims.nbf > now + 60)) {
      return { ok: false, reason: 'Microsoft bearer token is expired or not yet valid.' };
    }
    if (!claims.sub || typeof claims.sub !== 'string') return { ok: false, reason: 'Microsoft token has no user identity.' };

    let keys = await loadKeys();
    let jwk = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA');
    if (!jwk) {
      keys = await loadKeys(true);
      jwk = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA');
    }
    if (!jwk) return { ok: false, reason: 'Microsoft signing key was not found.' };
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const validSignature = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    );
    if (!validSignature) return { ok: false, reason: 'Microsoft bearer-token signature is invalid.' };

    const actor = claims.sub.trim().toLowerCase();
    const allowed = (recipients || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
    if (!allowed.length || !allowed.includes(actor)) {
      return { ok: false, reason: 'This user is not an approver assigned to this approval level.' };
    }
    if (Constants.ACTIONABLE_SENDER && String(claims.sender || '').toLowerCase() !== Constants.ACTIONABLE_SENDER.toLowerCase()) {
      return { ok: false, reason: 'The actionable-message sender does not match the configured sender.' };
    }
    return { ok: true, actor };
  } catch (error) {
    return { ok: false, reason: `Could not verify Microsoft action token: ${error.message}` };
  }
}

module.exports = { verifyRequest };