import { closeRedis, createRedis } from '../common/redis';
import { replayDeadLetters } from './dead-letters';

async function main(): Promise<void> {
  const redis = createRedis();
  try {
    const replayed = await replayDeadLetters(redis);
    process.stdout.write(`Put ${replayed} dead-lettered events back on their streams\n`);
  } finally {
    await closeRedis(redis);
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
