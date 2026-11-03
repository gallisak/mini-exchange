export const INSTRUMENTS: readonly string[] = (process.env.INSTRUMENTS ?? 'ABC,DEF,XYZ')
  .split(',')
  .map((instrument) => instrument.trim())
  .filter((instrument) => instrument.length > 0);
