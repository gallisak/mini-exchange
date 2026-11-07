export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { refuseUnsafeSecrets, warnAboutPlainCookies } = await import('./lib/server/secrets');
  try {
    refuseUnsafeSecrets();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  warnAboutPlainCookies();
}
