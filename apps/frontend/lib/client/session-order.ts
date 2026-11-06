export function answeredForCurrentSession(startedAt: number | undefined, signedInAt: number): boolean {
  return startedAt === undefined || startedAt >= signedInAt;
}
