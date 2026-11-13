
'use strict';

const BaseScenarioBuilder = require('./BaseScenarioBuilder');
const AmountUtil = require('../utils/AmountUtil');
const GroupUtil = require('../utils/GroupUtil');
const NormalizeUtil = require('../utils/NormalizeUtil');

class DepositConsolidationBuilder extends BaseScenarioBuilder {

  async buildDocuments(records, options, context) {

    const dailyGroups = GroupUtil.by(records, (r) => [
      this.getCompanyCode(r),
      this.getPortalCode(r),
      this.getPostingDate(r, options),
      NormalizeUtil.upper(r.TXN_CURRENCY)
    ].join('|'));

    const documents = [];
    const unbalanced = [];

    for (const groupRows of dailyGroups.values()) {

      if (!groupRows.length) continue;

      const first = groupRows[0];

      const companyCode = this.getCompanyCode(first);
      const postingDate = this.getPostingDate(first, options);

      const consolRefId =
        await context.referenceNumberService.nextConsolRefId(
          this.scenario,
          companyCode,
          postingDate
        );

      const sapRefDocument = '';
      const lineItems = [];

      let docRefItem = 1;

      const hostGroups = GroupUtil.by(
        groupRows,
        (r) => NormalizeUtil.host(r.HOST_NAME)
      );

      const merchantGroups = GroupUtil.by(
        groupRows,
        (r) => NormalizeUtil.text(r.MERCHANT_ID)
      );

      const hostCustomerCache = new Map();

      const resolveHostCustomer = (record) => {

        const cacheKey = [
          this.getCompanyCode(record),
          this.getPortalCode(record),
          NormalizeUtil.host(record.HOST_NAME)
        ].join('|');

        if (!hostCustomerCache.has(cacheKey)) {

          const hostBp = context.resolveHostCustomerBp(
            record,
            this.scenario
          );

          hostCustomerCache.set(cacheKey, {
            customerNumber: hostBp?.bpNumber || null,
            hostName:
              hostBp?.externalBpNumber ||
              NormalizeUtil.text(record.HOST_NAME)
          });
        }

        return hostCustomerCache.get(cacheKey);
      };

      const resolveMerchant = (record) => {

        const merchant = context.resolveMerchantBp(
          record,
          this.scenario
        );

        return {
          supplierNumber:
            merchant && typeof merchant === 'object'
              ? merchant.bpNumber
              : merchant,

          merchantId:
            (
              merchant &&
              typeof merchant === 'object' &&
              merchant.externalBpNumber
            ) ||
            NormalizeUtil.text(record.MERCHANT_ID)
        };
      };

      const addLineItem = ({
        baseRecord,
        amount,
        amountField,
        debitCredit,
        glAccount,
        customerNumber,
        supplierNumber,
        merchantId,
        hostName
      }) => {

        if (!AmountUtil.isNonZero(amount)) return;

        if (!amountField) {
          throw new Error(
            'Deposit line configuration is missing amountField'
          );
        }

        lineItems.push(
          this.createLineItem({
            consolRefId,
            sapRefDocument,
            docRefItem: docRefItem++,
            baseRecord,
            amount,
            amountField,
            debitCredit,
            glAccount: glAccount || null,
            customerNumber: customerNumber || null,
            supplierNumber: supplierNumber || null,
            merchantId: merchantId || null,
            hostName: hostName || null,
            options
          })
        );
      };

      const sumConfiguredAmount = (rows, field) => {

        if (!field) {
          throw new Error(
            'Deposit line configuration is missing amountField'
          );
        }

        return AmountUtil.sum(rows, field);
      };

      const resolveConfiguredGl = (record, field) => {

        if (!field) {
          throw new Error(
            'Deposit line configuration is missing glFlagField'
          );
        }

        return context.resolveGlAccount(record, field);
      };

 const blockHandlers = {

  ADD_HOST_LINE: (config) => {

    for (const hostRows of hostGroups.values()) {

      const base = hostRows[0];

      const amount = sumConfiguredAmount(
        hostRows,
        config.amountField
      );

      if (!AmountUtil.isNonZero(amount)) continue;

      const host = resolveHostCustomer(base);

      const gl = config.glFlagField
        ? resolveConfiguredGl(base, config.glFlagField)
        : null;

      addLineItem({
        baseRecord: base,
        amount,
        amountField: config.amountField,
        debitCredit: config.debitCredit,
        glAccount: gl,
        customerNumber: host.customerNumber,
        hostName: host.hostName
      });
    }
  },

  ADD_MERCHANT_LINE: (config) => {

    for (const merchantRows of merchantGroups.values()) {

      const base = merchantRows[0];

      const amount = sumConfiguredAmount(
        merchantRows,
        config.amountField
      );

      if (!AmountUtil.isNonZero(amount)) continue;

      const merchant = resolveMerchant(base);

      addLineItem({
        baseRecord: base,
        amount,
        amountField: config.amountField,
        debitCredit: config.debitCredit,
        supplierNumber: merchant.supplierNumber,
        merchantId: merchant.merchantId
      });
    }
  },

  ADD_TRANSACTION_LINE: (config) => {

    for (const transaction of groupRows) {

      if (!config.amountField) {
        throw new Error(
          'Deposit transaction line is missing amountField'
        );
      }

      const amount = transaction[config.amountField];

      if (!AmountUtil.isNonZero(amount)) continue;

      const gl = config.glFlagField
        ? resolveConfiguredGl(
            transaction,
            config.glFlagField
          )
        : null;

      if (config.glFlagField && !gl) {
        throw new Error(
          `GL account not found for Deposit field ${config.glFlagField}`
        );
      }

      const host = config.useHost
        ? resolveHostCustomer(transaction)
        : null;

      const merchant = config.useMerchant
        ? resolveMerchant(transaction)
        : null;

      addLineItem({
        baseRecord: transaction,
        amount,
        amountField: config.amountField,
        debitCredit: config.debitCredit,
        glAccount: gl,
        customerNumber: host?.customerNumber,
        hostName: host?.hostName,
        supplierNumber: merchant?.supplierNumber,
        merchantId: merchant?.merchantId
      });
    }
  }
};

      const blockOrder =
        this.scenario.depositLineBlockOrder ||
        this.scenario.lineBlockOrder ||
        [];

      const blockConfig =
        this.scenario.depositLineBlocks || {};

      if (!blockOrder.length) {
        throw new Error(
          'Deposit line block order is not configured in ScenarioConfig'
        );
      }

      for (const blockName of blockOrder) {

        const handler = blockHandlers[blockName];
        const config = blockConfig[blockName];

        if (!handler || !config) {
          throw new Error(
            `Deposit line block configuration missing or unsupported: ${blockName}`
          );
        }

        handler(config);
      }

      if (!lineItems.length) {
        throw new Error(
          `No Deposit line items generated for document ${consolRefId}`
        );
      }

      const totals = this.totalsFromLineItems(lineItems);

      const header = this.createHeader({
        consolRefId,
        sapRefDocument,
        groupRows,
        totals,
        options
      });

      const document = {
        header,
        lineItems,
        sourceTransactions: groupRows
      };

      if (this.isBalanced(document)) {
        documents.push(document);
      } else {
        unbalanced.push(document);
      }
    }

    return {
      documents,
      unbalanced
    };
  }
}

module.exports = DepositConsolidationBuilder;
