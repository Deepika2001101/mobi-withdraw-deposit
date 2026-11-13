'use strict';

const Constants = require('../constants/ConsolidationConstants');
const PaymentCatalog = require('../../shared/payment/PaymentCatalog');

class NormalizeUtil {
  static text(value) { return String(value ?? '').trim(); }
  static upper(value) { return this.text(value).toUpperCase(); }
  static compactUpper(value) { return this.upper(value).replace(/\s+/g, ''); }

  static normalizedWords(value) {
    return this.upper(value).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  static host(value) { return this.compactUpper(value); }

  static payment(value) {
    const n = this.normalizedWords(value);
    const aliases = {
      PAYINS: 'PAYIN', PAYIN: 'PAYIN',
      PAYOUTS: 'PAYOUT', PAYOUT: 'PAYOUT',
      NORMAL: 'NORMAL',
      'DOMESTIC SETTLEMENT': 'DOMESTIC SETTLEMENT',
      DOMESTICSETTLEMENT: 'DOMESTIC SETTLEMENT',
      DS: 'DOMESTIC SETTLEMENT',
      DEPOSIT: 'DEPOSIT', DEPOSITS: 'DEPOSIT',
      WITHDRAW: 'WITHDRAW', WITHDRAWS: 'WITHDRAW',
      WITHDRAWAL: 'WITHDRAW', WITHDRAWALS: 'WITHDRAW'
    };
    return aliases[n] || n;
  }

  static paymentCode(value) {
    const n = this.payment(value);
    if (n === 'PAYIN') return Constants.PAYMENT_CODES.PAYIN;
    if (n === 'PAYOUT') return Constants.PAYMENT_CODES.PAYOUT;
    if (n === 'DOMESTIC SETTLEMENT') return Constants.PAYMENT_CODES.DOMESTIC_SETTLEMENT;
    if (n === 'NORMAL') return Constants.PAYMENT_CODES.NORMAL;
    if (n === 'DEPOSIT') return Constants.PAYMENT_CODES.DEPOSIT;
    if (n === 'WITHDRAW') return Constants.PAYMENT_CODES.WITHDRAW;
    return Constants.PAYMENT_CODES.UNKNOWN;
  }

  // -------------------------------------------------------------------------
  // Canonical string tokens used for GL-account lookup keys.
  //
  // The legacy numeric paymentCode() cannot express the ~19 Deposit/Withdraw
  // sub types, so the GL lookup keys on canonical strings instead. Both GL rows
  // and transaction records pass through these same helpers, so matching stays
  // consistent for legacy (PAYIN/PAYOUT/DOMESTIC SETTLEMENT) and new types.
  // -------------------------------------------------------------------------

  /** Canonical payment-type token: PAYIN | PAYOUT | DEPOSIT | WITHDRAW | ''. */
  static paymentTypeToken(value) {
    return PaymentCatalog.normalizeType(value) || this.payment(value) || '';
  }

  /**
   * Canonical payment-sub-type token within a payment type.
   * Deposit/Withdraw resolve through the shared catalog (case/space/hyphen/
   * slash insensitive, alias-aware). Legacy sub types fall back to the
   * compacted legacy payment() normalisation.
   */
  static paymentSubTypeToken(type, value) {
    const canonical = PaymentCatalog.normalizeSubType(type, value);
    if (canonical) return PaymentCatalog.compact(canonical);
    return this.compactUpper(this.payment(value));
  }

  /** True when the payment type does not use a host (Deposit / Withdraw). */
  static isHostIndependentType(value) {
    return PaymentCatalog.isHostIndependentType(value);
  }
}

module.exports = NormalizeUtil;
