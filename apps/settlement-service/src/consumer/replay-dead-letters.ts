import { parseArgs } from 'util';
import { closeRedis, createRedis } from '../common/redis';
import { replayDeadLetters } from './dead-letters';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { id: { type: 'string', multiple: true } } });
  const redis = createRedis();
  try {
    const replayed = await replayDeadLetters(redis, { ids: values.id });
    process.stdout.write(`Put ${replayed} dead-lettered events back on their streams\n`);
  } finally {
    await closeRedis(redis);
  }
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
