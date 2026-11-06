import Redis from 'ioredis';

type StreamEntry = [id: string, fields: string[]];

export async function replayDeadLetters(
  redis: Redis,
  deadLetterStream = process.env.DEAD_LETTER_STREAM ?? 'settlement:dead-letter',
): Promise<number> {
  let replayed = 0;
  let after = '-';
  for (;;) {
    const entries = (await redis.xrange(deadLetterStream, after, '+', 'COUNT', 100)) as StreamEntry[];
    if (entries.length === 0) return replayed;
    for (const [id, raw] of entries) {
      const letter: Record<string, string> = {};
      for (let i = 0; i + 1 < raw.length; i += 2) letter[raw[i]] = raw[i + 1];
      if (!letter.stream || !letter.fields) continue;
      const fields = JSON.parse(letter.fields) as Record<string, string>;
      await redis
        .multi()
        .xadd(letter.stream, '*', ...Object.entries(fields).flat())
        .xdel(deadLetterStream, id)
        .exec();
      replayed += 1;
    }
    after = `(${entries[entries.length - 1][0]}`;
  }
}
