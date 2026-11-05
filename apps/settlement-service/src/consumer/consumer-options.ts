import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { intEnv } from '../common/env';

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

export function consumerOptionsFromEnv(): ConsumerOptions {
  return {
    group: process.env.CONSUMER_GROUP ?? 'settlement',
    consumer: `${process.env.INSTANCE_ID ?? hostname()}:${randomUUID()}`,
    deadLetterStream: process.env.DEAD_LETTER_STREAM ?? 'settlement:dead-letter',
    batchSize: intEnv('CONSUMER_BATCH_SIZE', 50),
    blockMs: intEnv('CONSUMER_BLOCK_MS', 1000),
    retryIdleMs: intEnv('CONSUMER_RETRY_IDLE_MS', 10000),
    reclaimEveryMs: intEnv('CONSUMER_RECLAIM_INTERVAL_MS', 5000),
    idleConsumerMs: intEnv('CONSUMER_IDLE_DELETE_MS', 3_600_000),
  };
}
