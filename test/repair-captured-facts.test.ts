/**
 * `gbrain repair captured-facts` and doctor `captured_facts_active`, on PGLite
 * and, with a safe DATABASE_URL, Postgres (test/e2e/repair-captured-facts-postgres.test.ts).
 *
 * Protects: capture-lane facts from gbrain's own claude-cli sessions are
 * expired by a hash-bound apply (fenced rows struck in their page so a later
 * write cannot reactivate them); paste candidates are listed but kept unless
 * --include-ambiguous; a claim with a legitimate active copy, a normal
 * session's fact and an unclassifiable session's fact are kept; nothing is
 * withdrawn, so remember can save the same claim again; the finding clears.
 * Seams: harness transcripts and the session corpus are files under a temp
 * CLAUDE_CONFIG_DIR and corpus dir; the legitimate copy is a raw coordinated
 * insert (the managed writer dedups a same-entity duplicate).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { capturedFactsCheck } from '../src/commands/doctor/checks/captured-facts.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string | null; applied: number; skipped: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number> }> }

/** Harness transcripts (one gbrain scratch project, one normal project) and a session corpus with a paste. */
function hostFiles(base: string) {
  const claude = join(base, 'claude');
  const scratch = join(claude, 'projects', '-tmp-gbrain-claude-cli-cwd-4242');
  const normal = join(claude, 'projects', '-home-user-work');
  mkdirSync(scratch, { recursive: true }); mkdirSync(normal, { recursive: true });
  writeFileSync(join(scratch, 'sess-self.jsonl'), '{}\n');
  writeFileSync(join(normal, 'sess-normal.jsonl'), '{}\n');
  writeFileSync(join(normal, 'sess-paste.jsonl'), '{}\n');
  const corpus = join(base, 'corpus');
  mkdirSync(corpus, { recursive: true });
  writeFileSync(join(corpus, 'sess-paste.txt'), '[user]\nCan you summarize this email?\n<pasted_content id="7">\n'
    + 'Acme Example raised a Series B round led by Fund Alpha at a forty million valuation.\n</pasted_content id="7">\n\n[assistant]\nSure.');
  writeFileSync(join(corpus, 'sess-normal.txt'), '[user]\nAlice joined Acme in 2024.\n\n[assistant]\nNoted.');
  return { claude, corpus };
}

async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['captured-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const applyArgs = (json: RepairJson) => json.results[0].apply_command!.split(' ').slice(3);

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const active = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ active: boolean }>('SELECT expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0]?.active;

async function seedEntity(engine: BrainEngine, root: string, slug: string, title: string, type: string) {
  const page = await engine.putPage(slug, { type: type as 'person', title, compiled_truth: `# ${title}` }, { sourceId: 'default' });
  await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, page.id]);
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  mkdirSync(join(root, slug.split('/')[0]!), { recursive: true });
  writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const base = mkdtempSync(join(tmpdir(), 'gbrain-captured-facts-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const { claude, corpus } = hostFiles(base);

  describe(`gbrain repair captured-facts, managed (${backend})`, () => {
    test('doctor finding, preview, hash-bound apply, paste kept until --include-ambiguous, remember still works', async () => {
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, () => managedBrain(async ({ engine, ctx }) => {
        await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
        // #6351: the shared repair core offers no apply command for an empty preview of a preview-bound kind.
        expect((await repair(engine, [])).results[0]).toMatchObject({ affected: 0, apply_command: null });
        const write = (fact: string, entity: string | null, provenance: string, sessionId: string) =>
          writeSingleFact(engine, 'default', { fact, entity, provenance, sessionId }).then(r => r.id);
        const self = await write('Alice Example prefers Rust for systems work', ALICE, 'hook:writeback', 'sess-self');
        const selfCompact = await write('Acme Example ships quarterly', ACME, 'hook:compact', 'sess-self');
        // An entity with no page: the managed writer keeps the row database-only (no fence row).
        const selfDbOnly = await write('Carol Absent dislikes long meetings', 'Carol Absent', 'hook:writeback', 'sess-self');
        const paste = await write('Acme Example raised a Series B round led by Fund Alpha', ACME, 'sweep:corpus', 'sweep:corpus:sess-paste.txt');
        const pasteOwn = await write('Acme Example wants a summary of an email', ACME, 'sweep:corpus', 'sweep:corpus:sess-paste.txt');
        const twinned = await write('Alice Example lives in Lisbon', ALICE, 'hook:writeback', 'sess-self');
        const normal = await write('Alice Example joined Acme Example in 2024', ALICE, 'hook:writeback', 'sess-normal');
        const gone = await write('Alice Example likes long walks', ALICE, 'hook:writeback', 'sess-gone');
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source)
          VALUES ('default', $1, 'Alice Example lives in Lisbon', 'fact', 'private', 'cli:remember')`, [ALICE]), TEST_WRITE_ATTRIBUTION));

        const finding = await capturedFactsCheck(engine);
        expect(finding.status).toBe('warn');
        expect(finding.details).toMatchObject({ evidenced: 3, ambiguous: 1, excluded: 1, unclassifiable: 1 });
        expect(finding.message).toContain('gbrain repair captured-facts');
        expect(finding.message).toContain('the self_capture check counts corpus files');
        const wave = (await runWaveChecks(engine, { only: 'wave' })).find(f => f.spec.id === 'captured_facts_active')!;
        expect(wave.state).toBe('finding');
        expect(wave.spec.count(wave.check.details!)).toBe(4);

        const preview = await repair(engine, []);
        expect(preview.results[0].residuals).toEqual({ evidenced: 3, ambiguous: 1, excluded: 1, unclassifiable: 1, not_suspect: 2 });
        const classes = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l.class]));
        expect(classes).toEqual({ [self]: 'evidenced', [selfCompact]: 'evidenced', [selfDbOnly]: 'evidenced', [paste]: 'ambiguous', [twinned]: 'excluded:legitimate_duplicate' });
        expect(preview.results[0].apply_command).toMatch(/^gbrain repair captured-facts --apply --expect [0-9a-f]+$/);
        expect((await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE id=$1', [selfDbOnly]))[0].row_num).toBeNull();
        for (const id of [self, selfCompact, selfDbOnly, paste, pasteOwn, twinned, normal, gone]) expect(await active(engine, id)).toBe(true);

        expect((await refusal(() => repair(engine, ['--apply']))).code).toBe('invalid_params');
        const applied = await repair(engine, applyArgs(preview));
        expect(applied.results[0].outcomes).toEqual({ expired: 3 });
        expect(await active(engine, self)).toBe(false);
        expect(await active(engine, selfDbOnly)).toBe(false);
        // Each expiry committed with a coordinator publication receipt.
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind'='managed_maintenance_expire_captured_facts'"))[0].n).toBe(1);
        expect(await active(engine, selfCompact)).toBe(false);
        for (const id of [paste, pasteOwn, twinned, normal, gone]) expect(await active(engine, id)).toBe(true);
        expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM fact_withdrawals'))[0].n).toBe(0);

        // The fenced row is struck in the page, so a later write of the page keeps it expired.
        const alice = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
        expect(alice.page.compiled_truth).toContain('~~Alice Example prefers Rust for systems work~~');
        await submitPageMutation(ctx, { operation: 'add_timeline_entry',
          params: { request_id: randomUUID(), slug: ALICE, date: '2026-03-01', summary: 'met for coffee', source: 'operator' } });
        expect(await active(engine, self)).toBe(false);

        expect((await capturedFactsCheck(engine)).details).toMatchObject({ evidenced: 0, ambiguous: 1 });
        const widened = await repair(engine, ['--include-ambiguous']);
        expect(widened.results[0].apply_command).toContain('--include-ambiguous --apply --expect');
        expect((await repair(engine, applyArgs(widened))).results[0].outcomes).toEqual({ expired: 1 });
        expect(await active(engine, paste)).toBe(false);
        for (const id of [pasteOwn, twinned, normal, gone]) expect(await active(engine, id)).toBe(true);
        expect((await capturedFactsCheck(engine)).status).toBe('ok');

        // Expired, not withdrawn: the same claim can be remembered again.
        const again = await writeSingleFact(engine, 'default', { fact: 'Alice Example prefers Rust for systems work', entity: ALICE, provenance: 'cli:remember' });
        expect(again.status).toBe('inserted');
        expect(await active(engine, again.id)).toBe(true);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        await seedEntity(engine, root, ALICE, 'Alice Example', 'person');
        await seedEntity(engine, root, ACME, 'Acme Example', 'company');
      } }));
    }, 180_000);

    test('a fact edited after the preview reports changed_since_preview and stays active', async () => {
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, () => managedBrain(async ({ engine }) => {
        const id = (await writeSingleFact(engine, 'default', { fact: 'Alice Example prefers tea', entity: ALICE, provenance: 'hook:writeback', sessionId: 'sess-self' })).id;
        const preview = await repair(engine, []);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]), TEST_WRITE_ATTRIBUTION));
        const applied = await repair(engine, applyArgs(preview));
        expect(applied.results[0].outcomes).toEqual({ changed_since_preview: 1 });
        expect(await active(engine, id)).toBe(true);
      }, { databaseUrl, setup: async ({ engine, root }) => { await seedEntity(engine, root, ALICE, 'Alice Example', 'person'); } }));
    }, 180_000);
  });

  describe(`gbrain repair captured-facts, unmanaged (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }, 120_000);
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

    test('database-only self-capture rows expire; the rest stay', async () => {
      const insert = async (fact: string, session: string) => Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, fact, kind, visibility, source, source_session) VALUES ('default', $1, $2, 'fact', 'private', 'hook:writeback', $3) RETURNING id`,
      [ALICE, fact, session]))[0].id);
      const self = await insert('Alice Example drinks oat milk', 'sess-self');
      const normal = await insert('Alice Example runs marathons', 'sess-normal');
      await withEnv({ CLAUDE_CONFIG_DIR: claude }, async () => {
        const preview = await repair(engine, []);
        expect(preview.results[0].residuals).toMatchObject({ evidenced: 1, not_suspect: 1 });
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ expired: 1 });
      });
      expect(await active(engine, self)).toBe(false);
      expect(await active(engine, normal)).toBe(true);
      const [row] = await engine.executeRaw<{ context: string }>('SELECT context FROM facts WHERE id=$1', [self]);
      expect(row.context).toContain('expired: captured-facts repair');
    }, 120_000);
  });
}
