export async function withTimeout<T>(command: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
