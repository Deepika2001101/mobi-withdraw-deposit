'use strict';

const DepositWithdrawConsolidationBuilder = require('./DepositWithdrawConsolidationBuilder');

module.exports = Object.freeze({
  PAYIN: require('./PayinConsolidationBuilder'),
  PAYOUT: require('./PayoutConsolidationBuilder'),
  DOMESTIC_SETTLEMENT: require('./DomesticSettlementConsolidationBuilder'),
  DEPOSIT: DepositWithdrawConsolidationBuilder,
  WITHDRAW: DepositWithdrawConsolidationBuilder
});
