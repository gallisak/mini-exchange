import { Counter, Histogram, collectDefaultMetrics, register } from 'prom-client';

collectDefaultMetrics();

export const metricsRegistry = register;

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by method, route and status',
  labelNames: ['method', 'route', 'status'],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by method and route',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

export const ordersAccepted = new Counter({
  name: 'orders_accepted_total',
  help: 'Orders accepted into the command log',
  labelNames: ['instrument'],
});

export const tradesExecuted = new Counter({
  name: 'trades_executed_total',
  help: 'Trades committed by this instance',
  labelNames: ['instrument'],
});

export const bookBatchFailures = new Counter({
  name: 'book_batch_failures_total',
  help: 'Command batches this instance failed to commit, by instrument',
  labelNames: ['instrument'],
});

export const bookReadFailures = new Counter({
  name: 'book_read_failures_total',
  help: 'Reads of a command stream this instance failed, by instrument',
  labelNames: ['instrument'],
});

export const outboxPublished = new Counter({
  name: 'outbox_published_total',
  help: 'Outbox messages relayed to Redis by this instance',
});
