export function latestRequest(): () => () => boolean {
  let last = 0;
  return () => {
    const mine = ++last;
    return () => mine === last;
  };
}

export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
