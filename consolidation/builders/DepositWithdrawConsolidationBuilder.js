'use strict';

const BaseScenarioBuilder = require('./BaseScenarioBuilder');
const AmountUtil = require('../utils/AmountUtil');
const NormalizeUtil = require('../utils/NormalizeUtil');
const Constants = require('../constants/ConsolidationConstants');
const PaymentCatalog = require('../../shared/payment/PaymentCatalog');

/**
 * Deposit / Withdraw consolidation builder (Book 19.xlsx).
 *
 * Unlike Payin/Payout (daily aggregation), each Deposit or Withdraw transaction
 * produces its OWN journal entry with exactly two line items:
 *
 *   DEPOSIT (Z4)
 *     1. GL clearing account  DEBIT  (S)  transaction_amount  + cost center + GL
 *     2. Merchant AP          CREDIT (H)  transaction_amount  + SAP supplier no.
 *
 *   WITHDRAW (Z3)
 *     1. Merchant AP          DEBIT  (S)  transaction_amount  + SAP supplier no.
 *     2. GL clearing account  CREDIT (H)  transaction_amount  + cost center + GL
 *
 * The clearing GL is resolved from the GL value-lookup table keyed by
 * company + payment type + payment sub type (host-independent), using the
 * TXN_AMOUNT flag. Both source references (HOST_REFERENCE_ID and
 * MERCHANT_REFERENCE_ID) are carried separately on the header and every line.
 *
 * A single class serves both scenarios; the scenario code decides the
 * debit/credit orientation. It is registered for DEPOSIT and WITHDRAW in
 * builders/index.js.
 */
class DepositWithdrawConsolidationBuilder extends BaseScenarioBuilder {
  // Keep the transaction's own sub type, canonicalised to the Sheet2 spelling.
  getOutputPaymentSubType(record) {
    return PaymentCatalog.normalizeSubType(record.PAYMENT_TYPE, record.PAYMENT_SUB_TYPE)
      || NormalizeUtil.text(record.PAYMENT_SUB_TYPE)
      || null;
  }

  async buildDocuments(records, options, context) {
    const documents = [];
    const unbalanced = [];
    const isDeposit = this.scenario.code === 'DEPOSIT';

    for (const record of records || []) {
      const companyCode = this.getCompanyCode(record);
      const postingDate = this.getPostingDate(record, options);

      const consolRefId = await context.referenceNumberService.nextConsolRefId(
        this.scenario, companyCode, postingDate
      );
      const sapRefDocument = '';

      const amount = AmountUtil.round2(record.TXN_AMOUNT);
      const glAccount = context.resolveGlAccount(record, 'TXN_AMOUNT');
      const merchantBp = context.resolveMerchantBp(record, this.scenario);
      const hostReferenceId = NormalizeUtil.text(record.HOST_REFERENCE_ID) || null;
      const merchantReferenceId = NormalizeUtil.text(record.MERCHANT_REFERENCE_ID) || null;

      // GL clearing line — carries the cost center and the looked-up GL.
      const glLine = this.createLineItem({
        consolRefId, sapRefDocument, docRefItem: 0, baseRecord: record, amount,
        amountField: 'TRANSACTION_AMOUNT',
        debitCredit: isDeposit ? Constants.DEBIT_CREDIT.DEBIT : Constants.DEBIT_CREDIT.CREDIT,
        glAccount, merchantId: '', hostName: '', options
      });
      glLine.HOST_REFERENCE_ID = hostReferenceId;
      glLine.MERCHANT_REFERENCE_ID = merchantReferenceId;

      // Merchant AP line — supplier number, no GL, no cost center.
      const merchantLine = this.createLineItem({
        consolRefId, sapRefDocument, docRefItem: 0, baseRecord: record, amount,
        amountField: 'TRANSACTION_AMOUNT',
        debitCredit: isDeposit ? Constants.DEBIT_CREDIT.CREDIT : Constants.DEBIT_CREDIT.DEBIT,
        supplierNumber: merchantBp.bpNumber,
        merchantId: merchantBp.externalBpNumber, hostName: '', options
      });
      merchantLine.HOST_REFERENCE_ID = hostReferenceId;
      merchantLine.MERCHANT_REFERENCE_ID = merchantReferenceId;
      merchantLine.COST_CENTER = null; // AP reconciliation line has no cost center

      // Line order mirrors the sample journal entries.
      const lineItems = isDeposit ? [glLine, merchantLine] : [merchantLine, glLine];
      lineItems.forEach((line, idx) => { line.DOC_REF_ITEM = idx + 1; });

      const totals = this.totalsFromLineItems(lineItems);
      const header = this.createHeader({
        consolRefId, sapRefDocument, groupRows: [record], totals, options
      });
      header.HOST_REFERENCE_ID = hostReferenceId;
      header.MERCHANT_REFERENCE_ID = merchantReferenceId;

      const document = { header, lineItems, sourceTransactions: [record] };
      if (this.isBalanced(document)) {
        documents.push(document);
      } else {
        unbalanced.push(document);
      }
    }

    return { documents, unbalanced };
  }
}

module.exports = DepositWithdrawConsolidationBuilder;
