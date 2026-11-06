export function latestRequest(): () => () => boolean {
  let last = 0;
  return () => {
    const mine = ++last;
    return () => mine === last;
  };
}
