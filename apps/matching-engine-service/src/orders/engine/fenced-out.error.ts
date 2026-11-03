export class FencedOutError extends Error {
  constructor(
    readonly instrument: string,
    readonly token: bigint,
    readonly currentFence: bigint | null,
  ) {
    super(
      `Fenced out of ${instrument}: token ${token}` +
        (currentFence === null ? ' lease expired' : `, current fence ${currentFence}`),
    );
  }
}
