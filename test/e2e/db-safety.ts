const UNSAFE_E2E_OVERRIDE = 'I_UNDERSTAND_THIS_WILL_TRUNCATE_THE_DATABASE';

export function assertSafeE2EDatabaseUrl(databaseUrl: string): void {
  const override = process.env.GBRAIN_E2E_ALLOW_UNSAFE_DATABASE;
  if (override === UNSAFE_E2E_OVERRIDE) return;

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing to run Postgres E2E: DATABASE_URL is not a valid URL.');
  }

  const protocol = parsed.protocol.replace(/:$/, '');
  if (protocol !== 'postgres' && protocol !== 'postgresql') {
    throw new Error(`Refusing to run Postgres E2E: unsupported DATABASE_URL protocol "${protocol}".`);
  }

  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, '').toLowerCase();
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'postgres';
  const isTestDatabase = /(^|[_-])(test|testing|e2e|ci)([_-]|$)/.test(dbName);

  if (isLocalHost && isTestDatabase) return;

  throw new Error(
    'Refusing to run destructive Postgres E2E against a non-test database. ' +
    'Use a local test DB such as postgresql://postgres:postgres@localhost:5433/gbrain_test. ' +
    `To override, set GBRAIN_E2E_ALLOW_UNSAFE_DATABASE=${UNSAFE_E2E_OVERRIDE}.`
  );
}
