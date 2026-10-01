import postgres from '#postgres';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { CompletedMigrationEntry } from '../../src/core/preferences.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { durableGitRepo } from './git-publication.ts';
import { LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './managed-legacy-fixture.ts';
import { withEnv } from './with-env.ts';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'ZEROENTROPY_API_KEY'];

export interface ChainRun { exitCode: number; stdout: string; stderr: string }

export interface ManagedChainFixture {
  home: string;
  root: string;
  seed: LegacySeed;
  /** Open a fresh engine on the fixture's database; the caller closes it before the next runner. */
  open(): Promise<BrainEngine>;
  /** The real `gbrain apply-migrations` runner in a child process: keyless, no service install. */
  applyMigrations(): Promise<ChainRun>;
  ledger(): CompletedMigrationEntry[];
  close(): Promise<void>;
}

/**
 * A managed brain whose legacy content predates every orchestrator
 * migration: an isolated home, config and migration ledger, a real Git
 * checkout claimed as the default source's canonical worktree, and a real
 * activation. The seed engine is closed before any runner starts.
 */
export async function managedChainFixture(databaseUrl?: string, opts: { config?: Record<string, string> } = {}): Promise<ManagedChainFixture> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-managed-chain-')));
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
    database = `gbrain_test_persistence_${randomUUID().replace(/-/g, '')}`;
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
  const env = { GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
  const close = async () => {
    if (admin && database) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
    rmSync(home, { recursive: true, force: true });
  };

  let seed!: LegacySeed;
  try {
    await withEnv(env, async () => {
      const engine = await open();
      try {
        await engine.initSchema();
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        seed = await seedLegacyManagedContent(engine, root);
        durableGitRepo(root, [`${LEGACY_FILE_SLUG}.md`, 'gbrain.yml']);
        await claimWorktree(engine, 'default', root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        for (const [key, value] of Object.entries(opts.config ?? {})) await engine.setConfig(key, value);
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.disconnect();
      }
    });
  } catch (error) {
    await close();
    throw error;
  }

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || PROVIDER_KEYS.includes(key) || key === 'DATABASE_URL' || key === 'GBRAIN_DATABASE_URL') continue;
    childEnv[key] = value;
  }
  Object.assign(childEnv, { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: '1' });

  return {
    home, root, seed, open, close,
    applyMigrations: async () => {
      const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, 'apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'],
        { cwd: home, env: childEnv, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stdout, stderr };
    },
    ledger: () => {
      try {
        return readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map(line => JSON.parse(line) as CompletedMigrationEntry);
      } catch { return []; }
    },
  };
}
