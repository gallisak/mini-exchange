import { randomUUID } from 'crypto';
import { hostname } from 'os';

export interface ConsumerOptions {
  group: string;
  consumer: string;
  deadLetterStream: string;
  batchSize: number;
  blockMs: number;
  retryIdleMs: number;
  reclaimEveryMs: number;
  idleConsumerMs: number;
}

const numberEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function consumerOptionsFromEnv(): ConsumerOptions {
  return {
    group: process.env.CONSUMER_GROUP ?? 'settlement',
    consumer: `${process.env.INSTANCE_ID ?? hostname()}:${randomUUID()}`,
    deadLetterStream: process.env.DEAD_LETTER_STREAM ?? 'settlement:dead-letter',
    batchSize: numberEnv('CONSUMER_BATCH_SIZE', 50),
    blockMs: numberEnv('CONSUMER_BLOCK_MS', 1000),
    retryIdleMs: numberEnv('CONSUMER_RETRY_IDLE_MS', 10000),
    reclaimEveryMs: numberEnv('CONSUMER_RECLAIM_INTERVAL_MS', 5000),
    idleConsumerMs: numberEnv('CONSUMER_IDLE_DELETE_MS', 3_600_000),
  };
}
