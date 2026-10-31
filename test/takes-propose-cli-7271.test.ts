/**
 * #7271: the takes proposal CLI.
 *
 * 1. Protects: \`takes list --status <x>\` refuses (takes list has no status filter) and points proposed takes at
 *    \`gbrain takes propose --json\` instead of silently listing active takes; \`takes propose --accept <id>\` without
 *    --dir works on a configured brain (a managed brain whose source has its checkout, and a repo-less brain), because
 *    the takes_add mutation resolves its own write root; the accept prints the accepted claim and its page.
 * 2. Fails when: --status is ignored again, accept requires sync.repo_path or --dir again, or the accept line drops
 *    the claim text.
 * 3. Why existing coverage misses it: every accept test passed --dir or set sync.repo_path, and no list test passed
 *    an unknown flag value.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runTakes } from '../src/commands/takes.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { put } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

async function insertProposal(engine: BrainEngine, slug: string, claim: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    "INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, domain, model_id, status) "
    + "VALUES ('default', $1, md5($2), 'test-v1', 'run-test', $2, 'bet', 'world', 0.7, NULL, 'test-model', 'pending') RETURNING id", [slug, claim]);
  return Number(rows[0]!.id);
}

/** runTakes with stdout and stderr captured and process.exit stubbed (it throws to stop the command, as the real exit would). */
async function run(engine: BrainEngine, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  let exitCode: number | null = null;
  const out: string[] = [];
  const err: string[] = [];
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalErr = console.error;
  (process.exit as unknown as (code?: number) => void) = ((code?: number) => { exitCode = code ?? 0; throw new Error('exit-' + code); }) as never;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try {
    await runTakes(engine, args);
  } catch (e) {
    if (exitCode === null) err.push(String(e));
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalErr;
  }
  return { exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

const status = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ status: string }>('SELECT status FROM take_proposals WHERE id = $1', [id]))[0]!.status;

describe('#7271 takes list --status', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  for (const value of ['proposed', 'active', 'bogus']) {
    test('--status ' + value + ' refuses, naming --expired and takes propose --json', async () => {
      const r = await run(engine, ['list', '--status', value]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('--expired');
      expect(r.stderr).toContain('gbrain takes propose --json');
      expect(r.stdout).toBe('');
    });
  }
});

describe('#7271 takes propose --accept on a repo-less brain', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('accepts with no repository and no --dir', async () => {
    await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'About acme-example.' });
    const id = await insertProposal(engine, 'companies/acme-example', 'Acme hires a CFO this year');
    const r = await run(engine, ['propose', '--accept', String(id)]);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Accepted proposal #' + id);
    expect(r.stdout).toContain('companies/acme-example: Acme hires a CFO this year');
    expect(await status(engine, id)).toBe('accepted');
    const takes = await engine.executeRaw<{ claim: string }>("SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'companies/acme-example'");
    expect(takes.map(t => t.claim)).toEqual(['Acme hires a CFO this year']);
  });
});

describe('#7271 takes propose --accept without --dir', () => {
  for (const backend of testBackends()) {
    test(backend + ': a managed brain accepts from its source checkout and prints the claim and page', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const slug = 'companies/acme-example';
        await put(ctx, slug, 'About acme-example.', 'company');
        expect(await engine.getConfig('sync.repo_path')).toBeNull();
        const id = await insertProposal(engine, slug, 'Acme ships the widget by Q3');
        const r = await run(engine, ['propose', '--accept', String(id)]);
        expect(r.stderr).toBe('');
        expect(r.exitCode).toBeNull();
        expect(r.stdout).toContain('Accepted proposal #' + id);
        expect(r.stdout).toContain(slug);
        expect(r.stdout).toContain('Acme ships the widget by Q3');
        expect(await status(engine, id)).toBe('accepted');
        const edited = await insertProposal(engine, slug, 'Acme doubles revenue');
        const e = await run(engine, ['propose', '--accept', String(edited), '--claim', 'Acme doubles revenue next year']);
        expect(e.stdout).toContain('Acme doubles revenue next year');
      }, { databaseUrl: backend === 'postgres' ? process.env.DATABASE_URL : undefined });
    }, 180_000);
  }
});
