export class TradeConflictError extends Error {
  constructor(readonly tradeId: string) {
    super(`Trade ${tradeId} was already settled with different details`);
  }
}
