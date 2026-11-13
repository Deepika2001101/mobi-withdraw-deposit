'use strict';
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const Constants = require('../constants/PoConstants');

function firstNonBlank(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeHost(value) {
  return String(value || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^smtps?:\/\//i, '')
    .replace(/\/+$/, '');
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function parseRecipients(value) {
  if (!value) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function collectRuleEntries(properties) {
  return Object.keys(properties || {})
    .filter((key) => key.startsWith(Constants.RULE_PREFIX))
    .sort()
    .map((key) => ({ key, raw: properties[key] }));
}

function buildConfig({ properties, destination, source }) {
  const port = toNumber(properties['mail.smtp.port'], 587);
  const user = firstNonBlank(
    properties['mail.smtp.user'],
    destination?.username,
    properties.User,
    properties['mail.from']
  );
  const password = firstNonBlank(
    properties['mail.smtp.password'],
    destination?.password,
    properties.Password
  );

  const config = {
    host: normalizeHost(firstNonBlank(properties['mail.smtp.host'], destination?.url)),
    port,
    user,
    password,
    from: firstNonBlank(properties['mail.from'], user),
    fromName: Constants.MAIL_FROM_NAME,
    cc: parseRecipients(properties['mail.cc']),
    bcc: parseRecipients(properties['mail.bcc']),
    fallbackRecipients: parseRecipients(properties['mail.to']),
    secure: port === 465,
    requireTLS: port !== 465 && toBoolean(properties['mail.smtp.starttls.enable'], port !== 465),
    schemaVersion: firstNonBlank(properties[Constants.SCHEMA_VERSION_KEY], '1'),
    onAmbiguousMatch: firstNonBlank(properties[Constants.AMBIGUOUS_KEY], 'ERROR').toUpperCase(),
    ruleEntries: collectRuleEntries(properties),
    properties,
    source
  };

  const missing = ['host', 'user', 'password'].filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`SMTP configuration incomplete via ${source}: missing ${missing.join(', ')}`);
  }
  return config;
}

async function fromDestination(destinationName = Constants.SMTP_DESTINATION) {
  const destination = await getDestination({ destinationName });
  if (!destination) throw new Error(`Destination ${destinationName} not found`);

  const config = buildConfig({
    properties: destination.originalProperties || {},
    destination,
    source: `BTP destination '${destination.name || destinationName}'`
  });

  console.log(
    `[PoSmtpDestination] Using ${config.source}: host=${config.host}, port=${config.port}, ` +
    `user=${config.user}, secure=${config.secure}, requireTLS=${config.requireTLS}, ` +
    `routingRules=${config.ruleEntries.length}, schemaVersion=${config.schemaVersion}, ` +
    `onAmbiguousMatch=${config.onAmbiguousMatch}`
  );
  return config;
}

function fromEnvironment() {
  const host = normalizeHost(process.env.SMTP_HOST || process.env.PO_SMTP_HOST);
  const user = firstNonBlank(process.env.SMTP_USER, process.env.PO_SMTP_USER);
  const password = firstNonBlank(process.env.SMTP_PASSWORD, process.env.PO_SMTP_PASSWORD);
  if (!host || !user || !password) return null;

  const port = toNumber(process.env.SMTP_PORT || process.env.PO_SMTP_PORT, 587);
  const rulesJson = process.env.PO_MAIL_APPROVAL_RULES; // JSON array of rule objects
  let ruleEntries = [];
  if (rulesJson) {
    try {
      const parsed = JSON.parse(rulesJson);
      ruleEntries = (Array.isArray(parsed) ? parsed : [parsed])
        .map((rule, index) => ({
          key: `${Constants.RULE_PREFIX}${String(index + 1).padStart(2, '0')}`,
          raw: JSON.stringify(rule)
        }));
    } catch (error) {
      console.warn(`[PoSmtpDestination] PO_MAIL_APPROVAL_RULES is not valid JSON: ${error.message}`);
    }
  }

  return {
    host,
    port,
    user,
    password,
    from: firstNonBlank(process.env.SMTP_FROM, process.env.MAIL_FROM, user),
    fromName: Constants.MAIL_FROM_NAME,
    cc: parseRecipients(process.env.PO_SMTP_CC),
    bcc: parseRecipients(process.env.PO_SMTP_BCC),
    fallbackRecipients: parseRecipients(process.env.MAIL_TO || process.env.SMTP_TO),
    secure: port === 465,
    requireTLS: port !== 465,
    schemaVersion: '1',
    onAmbiguousMatch: firstNonBlank(process.env.PO_MAIL_ON_AMBIGUOUS_MATCH, 'ERROR').toUpperCase(),
    ruleEntries,
    properties: {},
    source: 'environment variables (local fallback)'
  };
}

async function getPoSmtpConfig(destinationName) {
  try {
    return await fromDestination(destinationName);
  } catch (error) {
    console.warn(`[PoSmtpDestination] ${error.message}. Falling back to environment variables.`);
  }

  const envConfig = fromEnvironment();
  if (!envConfig) {
    throw new Error(
      `PO mail is not configured. Bind destination '${destinationName || Constants.SMTP_DESTINATION}' ` +
      '(Type MAIL) or set SMTP_HOST / SMTP_USER / SMTP_PASSWORD.'
    );
  }
  console.log('[PoSmtpDestination] Using environment variables (local fallback).');
  return envConfig;
}

function getMailEnvironment() {
  return firstNonBlank(
    process.env.CI_ENVIRONMENT,
    process.env.BTP_SPACE_NAME,
    (process.env.NODE_ENV || '').toUpperCase(),
    'DEV'
  );
}

module.exports = {
  getPoSmtpConfig,
  getMailEnvironment,
  parseRecipients,
  firstNonBlank
};