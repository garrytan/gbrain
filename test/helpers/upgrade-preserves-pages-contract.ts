import postgres from '#postgres';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { expect as bunExpect } from 'bun:test';
import { migrations } from '../../src/commands/migrations/index.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { CompletedMigrationEntry } from '../../src/core/preferences.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { durableGitRepo, git } from './git-publication.ts';
import { withEnv } from './with-env.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'ZEROENTROPY_API_KEY'];

export type BrainShape = 'repo-less' | 'repo';

const PAGES: Array<{ slug: string } & PageInput> = [
  { slug: 'concepts/upgrade-alpha', type: 'concept', title: 'Upgrade alpha', frontmatter: { source_kind: 'note', ingested_via: 'put' },
    compiled_truth: '# Upgrade alpha\n\nThe alpha page links to [[concepts/upgrade-beta]].' },
  { slug: 'concepts/upgrade-beta', type: 'concept', title: 'Upgrade beta', frontmatter: { tags_hint: 'tidal' },
    compiled_truth: '# Upgrade beta\n\nThe beta page is about lighthouse maintenance schedules.' },
  { slug: 'people/alice-example', type: 'person', title: 'Alice Example', frontmatter: { company: 'companies/acme-example' },
    compiled_truth: '# Alice Example\n\nAlice Example works at acme-example on storage engines.' },
];

async function pageState(engine: BrainEngine) {
  return engine.executeRaw<Record<string, unknown>>(
    'SELECT source_id, slug, content_hash, frontmatter::text AS frontmatter, compiled_truth FROM pages ORDER BY source_id, slug');
}

/**
 * #7814: a brain created by v0.59.2.0 (before `gbrain init` stamped
 * fresh-install migrations) carries pages written by that release and an
 * empty migration ledger, so every orchestrator lists as pending. Upgrading
 * it runs the real `gbrain apply-migrations` runner over the whole registry;
 * the run must complete and change no page: same content_hash, frontmatter
 * and body for every page and, on a repo brain, the same files and Git HEAD.
 *
 * The brain is built on the current schema (the schema migrations are the
 * upgrade matrix's job, scripts/upgrade-matrix); what makes it v0.59.2.0-shaped
 * is the ledger with no fresh-install stamps. `repo` is a Git checkout
 * claimed as the default source's canonical worktree with managed
 * persistence activated, as `gbrain init --git` leaves it.
 */
export async function runUpgradePreservesPages(databaseUrl: string | undefined, shape: BrainShape, expect: typeof bunExpect): Promise<void> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-upgrade-7814-')));
  const root = join(home, 'content');
  const bin = join(home, 'bin');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec bun run ${REPO}/src/cli.ts "$@"\n`);
  chmodSync(join(bin, 'gbrain'), 0o755);

  let admin: ReturnType<typeof postgres> | null = null;
  let database: string | null = null;
  let config: Record<string, unknown>;
  if (databaseUrl) {
    assertSafeE2eDatabaseUrl(databaseUrl);
    database = `gbrain_test_upgrade_${randomUUID().replace(/-/g, '')}`;
    admin = postgres(databaseUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const url = new URL(databaseUrl); url.pathname = `/${database}`;
    config = { engine: 'postgres', database_url: url.toString() };
  } else {
    config = { engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') };
  }
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ ...config, embedding_disabled: true }) + '\n', { mode: 0o600 });
  const open = async (): Promise<BrainEngine> => {
    const engine = config.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(config as never);
    return engine;
  };
  const files = PAGES.map(page => `${page.slug}.md`);
  const repoState = () => shape === 'repo'
    ? { head: git(root, 'rev-parse', 'HEAD').trim(), status: git(root, 'status', '--porcelain', '--', ...files).trim(),
        files: files.map(file => readFileSync(join(root, file), 'utf8')) }
    : null;

  try {
    let before!: Awaited<ReturnType<typeof pageState>>;
    await withEnv({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine = await open();
      try {
        await engine.initSchema();
        for (const page of PAGES) {
          const { slug, ...fields } = page;
          const written = await engine.putPage(slug, { ...fields, timeline: '' });
          if (shape !== 'repo') continue;
          await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, written.id]);
          const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
          mkdirSync(dirname(join(root, `${slug}.md`)), { recursive: true });
          writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
        }
        if (shape === 'repo') {
          await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
          durableGitRepo(root, files);
          await claimWorktree(engine, 'default', root);
          await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        }
        before = await pageState(engine);
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.disconnect();
      }
    });
    expect(before.length).toBe(PAGES.length);
    const repoBefore = repoState();

    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || PROVIDER_KEYS.includes(key) || key === 'DATABASE_URL' || key === 'GBRAIN_DATABASE_URL') continue;
      childEnv[key] = value;
    }
    Object.assign(childEnv, { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: '1' });
    const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, 'apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'],
      { cwd: home, env: childEnv, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const transcript = `exit=${exitCode}\n${stdout}\n${stderr}`;
    expect(exitCode, transcript).toBe(0);

    const ledger = readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as CompletedMigrationEntry);
    for (const migration of migrations) {
      expect(ledger.filter(e => e.version === migration.version).at(-1)?.status, `v${migration.version}\n${transcript}`).toBe('complete');
    }

    const engine = await open();
    try { expect(await pageState(engine)).toEqual(before); }
    finally { await engine.disconnect(); }
    expect(repoState()).toEqual(repoBefore);
  } finally {
    if (admin && database) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
    rmSync(home, { recursive: true, force: true });
  }
}
