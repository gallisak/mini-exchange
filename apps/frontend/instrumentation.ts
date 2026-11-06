export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { refusePlaceholderSecrets } = await import('./lib/server/secrets');
  try {
    refusePlaceholderSecrets();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
