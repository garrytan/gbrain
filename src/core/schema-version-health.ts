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
    // Forward skew: another node migrated the shared DB past what this client
    // knows (multi-node brain, hub + spokes on one Postgres). Warn, not fail
    // (#2036 semantics as shipped on master): the client can still read, and
    // "upgrade this client" is the real fix — apply-migrations here would be
    // actively wrong.
    return {
      status: 'warn',
      message:
        `Version ${version} is AHEAD of this client's latest known version (${latestVersion}). ` +
        'Another node migrated this DB past what this client knows — upgrade this client before writing.',
    };
  }

  return {
    status: 'warn',
    message: `Version ${version}, latest is ${latestVersion}. ${migrationFix}`,
  };
}
