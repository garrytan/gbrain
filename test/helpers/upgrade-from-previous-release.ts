/**
 * GBRA-248 gate condition 1 (backward compatible): the upgrade-from-previous-
 * release harness. Every wave of the embedded-core program extends it.
 *
 * A brain the previous release created (the newest schema-history fixture,
 * test/fixtures/schema-history/, one release's own fresh install) holding a
 * page, plus a config file in the previous release's keyless format, opens
 * under this build through the production path (the CLI, which migrates on
 * connect), keeps its page, and resolves the same settings as the frozen
 * goldens below. The config file is never rewritten. It runs for the three
 * brain shapes: a repo brain (the default source is a git checkout), the
 * default keyless content-directory brain, and a no-root (init --db-only)
 * brain.
 *
 * A wave that changes what the previous release's brain or config resolves
 * to fails here; a wave that adds a setting proves the setting's absence
 * leaves these goldens unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runCli, type CliResult } from './cli-spawn.ts';
import { schemaHistorySql, schemaHistoryVersions } from './schema-history.ts';

export type UpgradeEngine = 'pglite' | 'postgres';
export type BrainShape = 'repo' | 'content-directory' | 'no-root';
export const SHAPES: BrainShape[] = ['repo', 'content-directory', 'no-root'];

const SLUG = 'notes/upgrade-probe';
const TITLE = 'Upgrade probe';
const BODY = 'Written by the previous release.';

/** The keyless config file the previous release's init writes (gbrain init --pglite --no-embedding), database fields aside. */
export const PREVIOUS_RELEASE_KEYLESS_CONFIG = {
  embedding_disabled: true,
  schema_pack: 'gbrain-base-v2',
  mcp: { publish_skills: true },
  self_upgrade: { mode: 'notify', mode_prompted: true },
  protocol_installed_at: '2026-10-31T00:00:00.000Z',
};

/** Frozen golden: what gbrain config show resolves for that brain and config (a database URL prints with its credentials redacted). */
export function expectedConfigShow(engine: UpgradeEngine): string[] {
  return [
    'GBrain config:',
    '  engine: ' + engine,
    engine === 'pglite' ? '  database_path: <BRAIN>' : '  database_url: postgresql://***@<BRAIN>',
    '  embedding_disabled: true    (effective value (file: true, db: unset); either plane\'s true turns embedding off)',
    '  schema_pack: gbrain-base-v2    (file plane (~/.gbrain/config.json); the tier gbrain schema active resolves)',
    '  mcp: {"publish_skills":true}',
    '  self_upgrade: {"mode":"notify","mode_prompted":true}',
    '  protocol_installed_at: 2026-10-31T00:00:00.000Z',
  ];
}

/** Frozen golden: the default source as gbrain sources list --json reports it. */
export function expectedDefaultSource(shape: BrainShape): Record<string, unknown> {
  return {
    id: 'default',
    name: 'default',
    local_path: shape === 'no-root' ? null : shape === 'repo' ? '<HOME>/repo' : '<HOME>/.gbrain/content/default',
    federated: true,
    mirror_read_only: false,
    strategy: null,
    pull_strategy: 'rebase',
    page_count: 1,
    last_sync_at: null,
  };
}

export interface PreviousReleaseBrain {
  home: string;
  brain: string;
  config: string;
  configText: string;
  cli(args: string[]): Promise<CliResult>;
  normalize(text: string): string;
}

/** The SQL that puts the previous release's brain at the fixture version, holding one page, with the shape's default source. */
function shapeSql(shape: BrainShape, localPath: string | null): string {
  const path = localPath === null ? 'NULL' : "'" + localPath.replaceAll("'", "''") + "'";
  return [
    'UPDATE sources SET local_path = ' + path + " WHERE id = 'default';",
    "INSERT INTO pages (slug, type, title, compiled_truth, source_id) VALUES ('" + SLUG + "', 'concept', '" + TITLE + "', '" + BODY + "', 'default');",
  ].join('\n');
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' } });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
}

export async function previousReleaseBrain(engine: UpgradeEngine, shape: BrainShape, opts: { databaseUrl?: string; loadSql?: (sql: string) => Promise<void> } = {}): Promise<PreviousReleaseBrain> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-' + shape + '-'));
  const dir = join(home, '.gbrain');
  mkdirSync(dir, { recursive: true });
  const markdown = '---\ntype: concept\ntitle: ' + TITLE + '\n---\n' + BODY + '\n';
  let localPath: string | null = null;
  if (shape === 'repo') {
    localPath = join(home, 'repo');
    mkdirSync(join(localPath, 'notes'), { recursive: true });
    writeFileSync(join(localPath, SLUG + '.md'), markdown);
    git(localPath, ['init', '-q', '-b', 'main']);
    git(localPath, ['add', '.']);
    git(localPath, ['commit', '-q', '-m', 'previous release']);
  } else if (shape === 'content-directory') {
    localPath = join(dir, 'content', 'default');
    mkdirSync(join(localPath, 'notes'), { recursive: true });
    writeFileSync(join(localPath, SLUG + '.md'), markdown);
  }
  const version = schemaHistoryVersions(engine).at(-1)!;
  const sql = schemaHistorySql(engine, version) + '\n' + shapeSql(shape, localPath);
  const brain = engine === 'pglite' ? join(dir, 'brain.pglite') : opts.databaseUrl!;
  if (engine === 'pglite') {
    const loader = new PGLiteEngine();
    await loader.connect({ database_path: brain });
    try {
      await loader.db.exec(sql);
    } finally {
      await loader.disconnect();
    }
  } else {
    await opts.loadSql!(sql);
  }
  const config = join(dir, 'config.json');
  const configText = JSON.stringify({
    engine,
    ...(engine === 'pglite' ? { database_path: brain } : { database_url: brain }),
    ...PREVIOUS_RELEASE_KEYLESS_CONFIG,
  }, null, 2) + '\n';
  writeFileSync(config, configText);
  const redacted = engine === 'postgres' ? new URL(brain).host + new URL(brain).pathname : brain;
  const normalize = (text: string) => text.replaceAll(brain, '<BRAIN>').replaceAll(redacted, '<BRAIN>').replaceAll(home, '<HOME>');
  return {
    home,
    brain,
    config,
    configText,
    cli: (args) => runCli(args, { home, timeoutMs: 120_000 }),
    normalize,
  };
}

export function upgradeFromPreviousReleaseSuite(engine: UpgradeEngine, opts: { databaseUrl?: (shape: BrainShape) => Promise<string>; loadSql?: (url: string, sql: string) => Promise<void> } = {}): void {
  for (const shape of SHAPES) {
    describe('previous-release ' + shape + ' brain on ' + engine, () => {
      let b: PreviousReleaseBrain;
      let got: CliResult;
      let show: CliResult;
      let sources: CliResult;
      let version: CliResult;

      beforeAll(async () => {
        const url = await opts.databaseUrl?.(shape);
        b = await previousReleaseBrain(engine, shape, { databaseUrl: url, loadSql: url ? (sql) => opts.loadSql!(url, sql) : undefined });
        got = await b.cli(['get', SLUG]);
        show = await b.cli(['config', 'show']);
        sources = await b.cli(['sources', 'list', '--json']);
        version = await b.cli(['config', 'get', 'version']);
      }, 300_000);

      afterAll(() => {
        if (b) rmSync(b.home, { recursive: true, force: true });
      });

      test('opens through the CLI, migrates to the latest schema and keeps its page', () => {
        expect(got.exitCode, got.stderr).toBe(0);
        expect(got.stdout).toContain(TITLE);
        expect(got.stdout).toContain(BODY);
        expect(version.exitCode, version.stderr).toBe(0);
        expect(version.stdout.trim()).toBe(String(LATEST_VERSION));
      });

      test('resolves the same settings as the frozen golden', () => {
        expect(show.exitCode, show.stderr).toBe(0);
        expect(b.normalize(show.stdout).trimEnd().split('\n')).toEqual(expectedConfigShow(engine));
      });

      test('keeps the default source\'s shape', () => {
        expect(sources.exitCode, sources.stderr).toBe(0);
        const listed = JSON.parse(b.normalize(sources.stdout)) as { sources: Record<string, unknown>[] };
        expect(listed.sources).toEqual([expectedDefaultSource(shape)]);
      });

      test('never rewrites the previous release\'s config file', () => {
        expect(readFileSync(b.config, 'utf8')).toBe(b.configText);
      });
    });
  }
}
