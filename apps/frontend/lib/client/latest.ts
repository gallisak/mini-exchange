export interface RequestTurn {
  startedAt: Date;
  latest: () => boolean;
  show: () => boolean;
}

export function latestRequest(): () => RequestTurn {
  let last = 0;
  let shown = 0;
  return () => {
    const mine = ++last;
    return {
      startedAt: new Date(),
      latest: () => mine === last,
      show: () => {
        if (mine < shown) return false;
        shown = mine;
        return true;
      },
    };
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
