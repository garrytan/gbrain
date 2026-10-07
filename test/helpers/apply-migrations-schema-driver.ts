/**
 * #6089 driver: the real apply-migrations runner in a child process against a
 * stubbed orchestrator registry, so a test controls which orchestrator work is
 * pending while the schema-version check runs for real (PGLite or Postgres).
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

/**
 * `reconcile` is an applied re-check that runs on every pass (like the
 * shared-content migration); the others are pending. `migrate_schema` stamps
 * the schema at head; `hide_version` renames the config table so the version
 * cannot be read back; `fail` reports a failed orchestrator.
 */
export type StubMigration = 'reconcile' | 'noop' | 'migrate_schema' | 'hide_version' | 'fail';

export interface SchemaDriverOpts {
  args: string[];
  /**
   * `apply-migrations` (default) runs the runner with `args`; `post-upgrade`
   * runs `gbrain post-upgrade` in-process with `args`; `argv` runs the runner
   * with the driver's own arguments after a leading `apply-migrations`, so a
   * `gbrain` shim on PATH can stand in for the CLI.
   */
  entry?: 'apply-migrations' | 'post-upgrade' | 'argv';
  migrations: StubMigration[];
  /** Make the schema migration runner throw (a schema migration that cannot apply). */
  failSchemaMigrations?: boolean;
}

/** Writes the driver into `home` and marks the reconcile migration applied in the ledger. */
export function writeSchemaDriver(home: string, opts: SchemaDriverOpts): string {
  const ledgerDir = join(home, '.gbrain', 'migrations');
  mkdirSync(ledgerDir, { recursive: true });
  if (opts.migrations.includes('reconcile')) {
    appendFileSync(join(ledgerDir, 'completed.jsonl'), `${JSON.stringify({ version: '0.0.1', status: 'complete' })}\n`);
  }
  const stubs = opts.migrations.map((kind, i) => ({ kind, version: kind === 'reconcile' ? '0.0.1' : `0.0.${i + 2}` }));
  const driver = join(home, `schema-driver-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(driver, `import { mock } from 'bun:test';
import { appendFileSync, readFileSync } from 'node:fs';
const log = ${JSON.stringify(join(home, 'orchestrator.log'))};
const configPath = ${JSON.stringify(join(home, '.gbrain', 'config.json'))};
const migratePath = ${JSON.stringify(join(REPO, 'src/core/migrate.ts'))};
const realMigrate = { ...(await import(migratePath)) };
if (${opts.failSchemaMigrations === true}) {
  mock.module(migratePath, () => ({ ...realMigrate, runMigrations: async () => { throw new Error('stub schema migration failure'); } }));
}
async function withEngine(fn) {
  const { createEngine } = await import(${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))});
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const engine = await createEngine(cfg);
  await engine.connect(cfg);
  try { await fn(engine); } finally { await engine.disconnect(); }
}
const actions = {
  reconcile: async () => {},
  noop: async () => {},
  migrate_schema: () => withEngine(engine => engine.setConfig('version', String(realMigrate.LATEST_VERSION))),
  hide_version: () => withEngine(engine => engine.executeRaw('ALTER TABLE config RENAME TO config_hidden_6089')),
  fail: async () => {},
};
mock.module(${JSON.stringify(join(REPO, 'src/commands/migrations/index.ts'))}, () => ({
  compareVersions: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
  migrations: ${JSON.stringify(stubs)}.map(({ kind, version }) => ({
    version,
    ...(kind === 'reconcile' ? { reconcile: true } : {}),
    featurePitch: { headline: 'schema exit probe ' + kind },
    orchestrator: async () => {
      appendFileSync(log, 'ran ' + kind + '\\n');
      await actions[kind]();
      return { version, status: kind === 'fail' ? 'failed' : 'complete', phases: [] };
    },
  })),
}));
${entryCode(opts)}
process.exit(0);
`);
  return driver;
}

function entryCode(opts: SchemaDriverOpts): string {
  if (opts.entry === 'post-upgrade') {
    return `const { runPostUpgrade } = await import(${JSON.stringify(join(REPO, 'src/commands/upgrade.ts'))});
await runPostUpgrade(${JSON.stringify(opts.args)});`;
  }
  const args = opts.entry === 'argv' ? "process.argv.slice(2).filter((a, i) => i > 0 || a !== 'apply-migrations')" : JSON.stringify(opts.args);
  return `const { runApplyMigrations } = await import(${JSON.stringify(join(REPO, 'src/commands/apply-migrations.ts'))});
await runApplyMigrations(${args});`;
}

/** The `--json` failure envelope (or success document) a run printed on stdout. */
export function parseDocument(stdout: string): Record<string, any> {
  const line = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
  if (!line) throw new Error(`no JSON document on stdout: ${stdout}`);
  return JSON.parse(line);
}
