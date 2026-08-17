export interface SchemaVersionHealth {
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

/** Compare the database schema with the schema understood by this client. */
export function schemaVersionHealth(
  version: number,
  latestVersion: number,
  opts: { remote?: boolean } = {},
): SchemaVersionHealth {
  const migrationFix = opts.remote
    ? 'Run `gbrain apply-migrations --yes` on the host.'
    : 'Fix: gbrain apply-migrations --yes';

  if (version === latestVersion) {
    return { status: 'ok', message: `Version ${version} (latest: ${latestVersion})` };
  }

  if (version === 0) {
    return {
      status: 'fail',
      message: opts.remote
        ? `No schema version recorded. Migrations never ran. ${migrationFix}`
        : `No schema version recorded. Migrations never ran. ${migrationFix}. ` +
          `If you installed via 'bun install -g github:...', see https://github.com/garrytan/gbrain/issues/218.`,
    };
  }

  if (version > latestVersion) {
    return {
      status: 'fail',
      message:
        `Database schema version ${version} is newer than this client's latest ${latestVersion}. ` +
        'Upgrade gbrain before performing writes; do not run migrations with this client.',
    };
  }

  return {
    status: 'warn',
    message: `Version ${version}, latest is ${latestVersion}. ${migrationFix}`,
  };
}
