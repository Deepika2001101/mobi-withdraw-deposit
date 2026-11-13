'use strict';
const Constants = require('../constants/PoConstants');
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function normalizeText(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeText(entry)).filter(Boolean);
}

function isWildcard(list) {
  return list.length === 0 || list.includes('*');
}

function listMatches(list, value) {
  return isWildcard(list) || list.includes(normalizeText(value));
}

function specificity(rule, companyCode, documentType) {
  return {
    companyCodeExact: !isWildcard(rule.companyCodes) && rule.companyCodes.includes(normalizeText(companyCode)),
    documentTypeExact: !isWildcard(rule.documentTypes) && rule.documentTypes.includes(normalizeText(documentType)),
    companyCodeSize: rule.companyCodes.length,
    documentTypeSize: rule.documentTypes.length
  };
}

function compareSpecificityRank(a, b) {
  const sa = a.specificity;
  const sb = b.specificity;
  return (Number(sb.companyCodeExact) - Number(sa.companyCodeExact))
    || (Number(sb.documentTypeExact) - Number(sa.documentTypeExact))
    || (sa.companyCodeSize - sb.companyCodeSize)
    || (sa.documentTypeSize - sb.documentTypeSize);
}

function compareSpecificity(a, b) {
  return compareSpecificityRank(a, b) || a.rule.key.localeCompare(b.rule.key);
}

class PoApprovalRouting {
  /**
   * @param {object} options
   * @param {Array<{key:string,raw:string}>} options.ruleEntries raw destination entries
   * @param {string} [options.onAmbiguousMatch] 'ERROR' | 'FIRST'
   * @param {string} [options.schemaVersion]
   */
  constructor({ ruleEntries = [], onAmbiguousMatch = 'ERROR', schemaVersion = '1', strictJson = false } = {}) {
    this.schemaVersion = schemaVersion;
    this.onAmbiguousMatch = normalizeText(onAmbiguousMatch) || 'ERROR';
    this.strictJson = strictJson;
    this.rules = [];
    this.parseErrors = [];
    this._parse(ruleEntries);
  }

  static fromConfig(config) {
    return new PoApprovalRouting({
      ruleEntries: config?.ruleEntries || [],
      onAmbiguousMatch: config?.onAmbiguousMatch || 'ERROR',
      schemaVersion: config?.schemaVersion || '1'
    });
  }

  _parse(ruleEntries) {
    for (const entry of ruleEntries || []) {
      let parsed;
      try {
        parsed = typeof entry.raw === 'string' ? JSON.parse(entry.raw) : entry.raw;
      } catch (error) {
        const message = `Routing rule '${entry.key}' is not valid JSON: ${error.message}`;
        this.parseErrors.push({ key: entry.key, message });
        console.error(`[PoApprovalRouting] ${message}`);
        if (this.strictJson) throw new Error(message);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        this.parseErrors.push({ key: entry.key, message: `Routing rule '${entry.key}' is not an object` });
        continue;
      }

      const levels = parsed.approvalLevels && typeof parsed.approvalLevels === 'object'
        ? parsed.approvalLevels
        : {};

      this.rules.push({
        key: entry.key,
        ruleId: normalizeText(parsed.ruleId) || entry.key,
        companyCodes: normalizeList(parsed.companyCodes),
        documentTypes: normalizeList(parsed.documentTypes),
        action: normalizeText(parsed.action) || 'SEQUENTIAL_APPROVAL',
        approvalLevels: levels,
        levelNumbers: Object.keys(levels)
          .map((level) => Number(level))
          .filter((level) => Number.isFinite(level))
          .sort((a, b) => a - b)
      });
    }

    console.log(
      `[PoApprovalRouting] Loaded ${this.rules.length} routing rule(s) ` +
      `(schemaVersion=${this.schemaVersion}, onAmbiguousMatch=${this.onAmbiguousMatch})`
    );
  }

  /**
   * All rules matching company code + document type, most specific first.
   * @returns {Array<{rule:object, specificity:object}>}
   */
  matches(companyCode, documentType) {
    return this.rules
      .filter((rule) => listMatches(rule.companyCodes, companyCode)
        && listMatches(rule.documentTypes, documentType))
      .map((rule) => ({ rule, specificity: specificity(rule, companyCode, documentType) }))
      .sort(compareSpecificity);
  }

  /**
   * Resolve the single applicable rule.
   * @throws when nothing matches, or when a tie exists and onAmbiguousMatch=ERROR
   */
  resolve(companyCode, documentType) {
    if (!this.rules.length) {
      throw new Error(
        `No PO approval routing rules found on the destination. Expected properties '${Constants.RULE_PREFIX}01' … '${Constants.RULE_PREFIX}NN'.`
      );
    }

    const matches = this.matches(companyCode, documentType);
    if (!matches.length) {
      throw new Error(
        `No PO approval routing rule matches CompanyCode '${companyCode || '(blank)'}' ` +
        `with DocumentType '${documentType || '(blank)'}'.`
      );
    }

    const best = matches[0];
    const tied = matches.slice(1).filter((candidate) => compareSpecificityRank(candidate, best) === 0);
    if (tied.length) {
      const ids = [best.rule.ruleId, ...tied.map((candidate) => candidate.rule.ruleId)].join(', ');
      if (this.onAmbiguousMatch === 'ERROR') {
        throw new Error(
          `Ambiguous PO approval routing for CompanyCode '${companyCode}' / DocumentType '${documentType}': ` +
          `rules ${ids} all match with equal specificity (onAmbiguousMatch=ERROR).`
        );
      }
      console.warn(
        `[PoApprovalRouting] Ambiguous match (${ids}) — onAmbiguousMatch=${this.onAmbiguousMatch}, using ${best.rule.ruleId}.`
      );
    }

    return best.rule;
  }
  recipientsForLevel(rule, level = Constants.TRIGGER_APPROVAL_LEVEL) {
    const raw = rule?.approvalLevels?.[String(level)]
      || rule?.approvalLevels?.[level]
      || [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    const seen = new Set();
    const valid = [];
    for (const entry of list) {
      const address = String(entry ?? '').trim();
      const lowered = address.toLowerCase();
      if (!lowered || seen.has(lowered)) continue;
      if (!EMAIL_PATTERN.test(lowered)) {
        console.warn(`[PoApprovalRouting] Rule ${rule.ruleId} level ${level}: ignoring invalid address '${address}'.`);
        continue;
      }
      seen.add(lowered);
      valid.push(lowered);
    }
    return valid;
  }

  approvalChain(rule) {
    return (rule?.levelNumbers || []).map((level) => ({
      level,
      recipients: this.recipientsForLevel(rule, level)
    })).filter((entry) => entry.recipients.length);
  }
  isAutoApprove(rule) {
    return normalizeText(rule?.action) === Constants.AUTO_APPROVE_ACTION;
  }

  describe() {
    return {
      schemaVersion: this.schemaVersion,
      onAmbiguousMatch: this.onAmbiguousMatch,
      parseErrors: this.parseErrors,
      rules: this.rules.map((rule) => ({
        key: rule.key,
        ruleId: rule.ruleId,
        companyCodes: rule.companyCodes,
        documentTypes: rule.documentTypes,
        action: rule.action,
        approvalLevels: Object.fromEntries(
          Object.entries(rule.approvalLevels).map(([level, list]) => [level, (Array.isArray(list) ? list : [list]).length])
        )
      }))
    };
  }
}

module.exports = PoApprovalRouting;