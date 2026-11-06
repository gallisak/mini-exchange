import Redis from 'ioredis';

type StreamEntry = [id: string, fields: string[]];

export const GAVE_UP = 'gave up after';

export async function replayDeadLetters(
  redis: Redis,
  options: { ids?: string[]; deadLetterStream?: string } = {},
): Promise<number> {
  const deadLetterStream = options.deadLetterStream ?? process.env.DEAD_LETTER_STREAM ?? 'settlement:dead-letter';
  const chosen = options.ids && options.ids.length > 0 ? new Set(options.ids) : null;
  let replayed = 0;
  let after = '-';
  for (;;) {
    const entries = (await redis.xrange(deadLetterStream, after, '+', 'COUNT', 100)) as StreamEntry[];
    if (entries.length === 0) return replayed;
    for (const [id, raw] of entries) {
      const letter: Record<string, string> = {};
      for (let i = 0; i + 1 < raw.length; i += 2) letter[raw[i]] = raw[i + 1];
      if (!letter.stream || !letter.fields) continue;
      if (chosen ? !chosen.has(id) : !letter.reason?.startsWith(GAVE_UP)) continue;
      const fields = JSON.parse(letter.fields) as Record<string, string>;
      const results = await redis
        .multi()
        .xadd(letter.stream, '*', ...Object.entries(fields).flat())
        .xdel(deadLetterStream, id)
        .exec();
      const failed = results?.find(([error]) => error);
      if (!results || failed) {
        throw new Error(`Could not replay dead letter ${id}: ${failed?.[0]?.message ?? 'the transaction was aborted'}`);
      }
      replayed += 1;
    }
    after = `(${entries[entries.length - 1][0]}`;
  }
}
