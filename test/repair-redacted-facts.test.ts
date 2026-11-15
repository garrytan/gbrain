/**
 * `gbrain repair redacted-facts` (#7125) and doctor `facts_redaction_marker`, on PGLite
 * and, with a safe DATABASE_URL, Postgres (test/e2e/repair-redacted-facts-postgres.test.ts).
 *
 * Protects: a fact whose stored text lost a word to the pre-fix sanitizer
 * ("Business [redacted](ABS)") is restored only from a source page that proves
 * the original words; a fenced row is rewritten in its page (so the canonical
 * projection keeps it) and a database-only row in place; a fact no source can
 * prove, or whose sources disagree, is listed and left unchanged; the apply is
 * bound to the preview hash; a fact edited since the preview is reported and
 * kept; the finding clears.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { factsRedactionMarkerCheck } from '../src/commands/doctor/checks/facts-redaction-marker.ts';
import { restoreRedactedRows } from '../src/core/repair/redacted-facts.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';

const ACME = 'companies/acme-example';
const NOTES = 'notes/operating-models';
const SOURCE_TEXT = 'Reading list. The Acme Business System (ABS) was developed under the CEO in the 1980s. '
  + 'The Example Operating System (EXOS) is positioned as a layer beneath the planning tools.';
const ABS_DAMAGED = 'Acme Business [redacted](ABS) was developed under the CEO in the 1980s';
const ABS_RESTORED = 'Acme Business System (ABS) was developed under the CEO in the 1980s';
const EXOS_DAMAGED = 'The Example Operating [redacted](EXOS) is positioned as a layer beneath the planning tools';
const EXOS_RESTORED = 'The Example Operating System (EXOS) is positioned as a layer beneath the planning tools';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number> }> }

async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['redacted-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const applyArgs = (json: RepairJson) => json.results[0].apply_command.split(' ').slice(3);

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const factText = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ fact: string; active: boolean }>('SELECT fact, expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0];
const CONVERSATION = 'conversations/planning-call';
const insertExtractorFact = async (db: BrainEngine, fact: string, rowNum: number) => Number((await db.executeRaw<{ id: number }>(`INSERT INTO facts
  (source_id, entity_slug, fact, kind, visibility, source, context, row_num, source_markdown_slug)
  VALUES ('default', $1, $2, 'fact', 'private', 'cli:extract-conversation-facts', $3, $4, $3) RETURNING id`, [ACME, fact, CONVERSATION, rowNum]))[0].id);
const extractorRow = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ fact: string; row_num: number; source_markdown_slug: string; active: boolean }>(
  'SELECT fact, row_num::int AS row_num, source_markdown_slug, expired_at IS NULL AS active FROM facts WHERE id=$1', [id]))[0];
const putPage = (ctx: OperationContext, slug: string, content: string) =>
  submitPageMutation(ctx, { operation: 'put_page', params: { request_id: randomUUID(), slug, source_id: 'default', content } });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`gbrain repair redacted-facts, managed (${backend})`, () => {
    test('doctor finding, preview, hash-bound apply: fenced and database-only rows restored, unprovable and conflicting rows kept', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---
type: note
title: Operating models
---
${SOURCE_TEXT}
`);
        await putPage(ctx, 'notes/launches', '---\ntype: note\ntitle: Launches\n---\nThe Acme Shell (ACS) launch slipped. Later the Acme System (ACS) launch shipped.\n');
        const fence = renderFactsTable([
          { rowNum: 1, claim: ABS_DAMAGED, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true, context: NOTES },
          { rowNum: 2, claim: 'Acme Example ships quarterly', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
        ] as never);
        await putPage(ctx, ACME, `---
type: company
title: Acme Example
---
Acme Example notes.

## Facts

${fence}
`);
        const [fenced] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_markdown_slug=$1 AND row_num=1 AND expired_at IS NULL", [ACME]);
        expect(fenced).toBeDefined();
        const insert = (fact: string, context: string | null) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
            VALUES ('default', $1, $2, 'fact', 'private', 'mcp:put_page', $3) RETURNING id`, [ACME, fact, context]))[0].id), TEST_WRITE_ATTRIBUTION));
        const dbOnly = await insert(EXOS_DAMAGED, NOTES);
        const unproven = await insert('Some vendor [redacted](VND) rollout finished', NOTES);
        const noPage = await insert('The Retail Operating [redacted](ROS) pilot ended', 'notes/deleted-page');
        const conflicting = await insert('The Acme [redacted](ACS) launch', 'notes/launches');
        const fencedId = Number(fenced!.id);

        const finding = await factsRedactionMarkerCheck(engine);
        expect(finding.status).toBe('warn');
        expect(finding.details).toMatchObject({ affected: 5 });
        expect(finding.message).toContain('gbrain repair redacted-facts');
        const wave = (await runWaveChecks(engine, { only: 'wave' })).find(f => f.spec.id === 'facts_redaction_marker')!;
        expect(wave.state).toBe('finding');
        expect(wave.spec.count(wave.check.details!)).toBe(5);

        const preview = await repair(engine, []);
        expect(preview.results[0].residuals).toEqual({ evidenced: 2, ambiguous: 1, unproven: 2, segmented: 0 });
        const classes = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l.class]));
        expect(classes).toEqual({ [fencedId]: 'evidenced', [dbOnly]: 'evidenced', [unproven]: 'unproven', [noPage]: 'unproven', [conflicting]: 'ambiguous' });
        expect(preview.results[0].listing!.find(l => l.item.endsWith(`#${fencedId}`))!.detail).toContain(ABS_RESTORED);
        expect(preview.results[0].apply_command).toMatch(/^gbrain repair redacted-facts --apply --expect [0-9a-f]+$/);
        expect((await factText(engine, dbOnly)).fact).toBe(EXOS_DAMAGED);

        expect((await refusal(() => repair(engine, ['--apply']))).code).toBe('invalid_params');
        const applied = await repair(engine, applyArgs(preview));
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });

        // Database-only row: rewritten in place by one committed maintenance request.
        expect(await factText(engine, dbOnly)).toEqual({ fact: EXOS_RESTORED, active: true });
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND intent->>'kind'='managed_maintenance_restore_redacted_facts'"))[0].n).toBe(1);
        // Fenced row: rewritten in the page; the projection now carries the restored claim at the same row.
        const page = (await engine.readPageSnapshot(ACME, { sourceId: 'default' }))!;
        expect(page.page.compiled_truth).toContain(ABS_RESTORED);
        expect(page.page.compiled_truth).not.toContain('[redacted]');
        const [projected] = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_markdown_slug=$1 AND row_num=1 AND expired_at IS NULL', [ACME]);
        expect(projected!.fact).toBe(ABS_RESTORED);
        // Unprovable and conflicting rows are untouched.
        expect((await factText(engine, unproven)).fact).toBe('Some vendor [redacted](VND) rollout finished');
        expect((await factText(engine, noPage)).fact).toBe('The Retail Operating [redacted](ROS) pilot ended');
        expect((await factText(engine, conflicting)).fact).toBe('The Acme [redacted](ACS) launch');

        expect((await factsRedactionMarkerCheck(engine)).details).toMatchObject({ affected: 3 });
        expect((await repair(engine, [])).results[0].residuals).toEqual({ evidenced: 0, ambiguous: 1, unproven: 2, segmented: 0 });
      }, { databaseUrl });
    }, 180_000);

    test('a fact edited after the preview reports changed_since_preview and keeps its text', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, NOTES, `---
type: note
title: Operating models
---
${SOURCE_TEXT}
`);
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () =>
          Number((await tx.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
            VALUES ('default', $1, $2, 'fact', 'private', 'mcp:put_page', $3) RETURNING id`, [ACME, EXOS_DAMAGED, NOTES]))[0].id), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]), TEST_WRITE_ATTRIBUTION));
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ changed_since_preview: 1 });
        expect((await factText(engine, id)).fact).toBe(EXOS_DAMAGED);
      }, { databaseUrl });
    }, 180_000);

    test('#8820: a conversation-extractor row (legacy row number, no Facts fence) is restored in place; its page is unchanged', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage(ctx, CONVERSATION, `---\ntype: note\ntitle: Planning call\n---\n${SOURCE_TEXT}\n`);
        const before = (await engine.readPageSnapshot(CONVERSATION, { sourceId: 'default' }))!;
        const id = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => insertExtractorFact(tx, ABS_DAMAGED, 3), TEST_WRITE_ATTRIBUTION));
        const preview = await repair(engine, []);
        expect(preview.results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, unproven: 0, segmented: 0 });
        expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
        expect(await extractorRow(engine, id)).toEqual({ fact: ABS_RESTORED, row_num: 3, source_markdown_slug: CONVERSATION, active: true });
        const after = (await engine.readPageSnapshot(CONVERSATION, { sourceId: 'default' }))!;
        expect(after.revision).toBe(before.revision);
        expect(after.page.compiled_truth).toBe(before.page.compiled_truth);
        expect((await factsRedactionMarkerCheck(engine)).status).toBe('ok');
      }, { databaseUrl });
    }, 180_000);
  });

  describe(`gbrain repair redacted-facts, unmanaged (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }, 120_000);
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

    test('a retained page version proves the words the current page no longer holds', async () => {
      const page = await engine.putPage(NOTES, { type: 'note', title: 'Operating models', compiled_truth: 'Rewritten notes without the list.' }, { sourceId: 'default' });
      await engine.executeRaw('INSERT INTO page_versions (page_id, compiled_truth) VALUES ($1, $2)', [page.id, SOURCE_TEXT]);
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3) RETURNING id`, [ACME, ABS_DAMAGED, NOTES]))[0].id);
      const preview = await repair(engine, []);
      expect(preview.results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, unproven: 0, segmented: 0 });
      expect(preview.results[0].listing![0].detail).toContain(`${NOTES}@version:`);
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      const [row] = await engine.executeRaw<{ fact: string; context: string }>('SELECT fact, context FROM facts WHERE id=$1', [id]);
      expect(row!.fact).toBe(ABS_RESTORED);
      expect(row!.context).toBe(`${NOTES} | restored: redacted-facts repair`);
      expect((await factsRedactionMarkerCheck(engine)).status).toBe('ok');
    }, 120_000);

    test('a segmented source page proves a restoration from its second segment; a proved fenced row on a segmented page is listed, never rewritten', async () => {
      const source = 'notes/segmented-models';
      const held = 'companies/segmented-example';
      await createSegmentedPage(engine, { slug: source, truth: `${'Filler line.\n'.repeat(90_000)}${SOURCE_TEXT}\n` });
      await createSegmentedPage(engine, { slug: held, truth: 'Segmented example notes.\n' });
      const insert = async (fact: string, rowNum: number | null, holder: string | null) => Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, fact, kind, visibility, source, context, row_num, source_markdown_slug)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3, $4, $5) RETURNING id`, [held, fact, source, rowNum, holder]))[0].id);
      const dbOnly = await insert(EXOS_DAMAGED, null, null);
      const fenced = await insert(ABS_DAMAGED, 1, held);
      const preview = await repair(engine, []);
      expect(preview.results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, unproven: 0, segmented: 1 });
      const listed = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l]));
      expect(listed[dbOnly]!.class).toBe('evidenced');
      expect(listed[fenced]!.class).toBe('segmented');
      expect(listed[fenced]!.detail).toContain(ABS_RESTORED);
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      expect((await factText(engine, dbOnly)).fact).toBe(EXOS_RESTORED);
      expect((await factText(engine, fenced)).fact).toBe(ABS_DAMAGED);
      await engine.executeRaw('DELETE FROM facts WHERE id=$1', [fenced]);
    }, 120_000);

    test('#8820: a conversation-extractor row on a segmented page with no Facts fence is restored in place', async () => {
      const conversation = 'conversations/segmented-call';
      await createSegmentedPage(engine, { slug: conversation, truth: `${'Filler line.\n'.repeat(90_000)}${SOURCE_TEXT}\n` });
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts
        (source_id, entity_slug, fact, kind, visibility, source, context, row_num, source_markdown_slug)
        VALUES ('default', $1, $2, 'fact', 'private', 'cli:extract-conversation-facts', $3, 3, $3) RETURNING id`, [ACME, ABS_DAMAGED, conversation]))[0].id);
      const preview = await repair(engine, []);
      const listed = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l.class]));
      expect(listed[id]).toBe('evidenced');
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      expect(await extractorRow(engine, id)).toEqual({ fact: ABS_RESTORED, row_num: 3, source_markdown_slug: conversation, active: true });
      await engine.executeRaw('DELETE FROM facts WHERE id=$1', [id]);
    }, 120_000);

    test('#8820: a conversation-extractor row is restored in place; a fenced row number whose fence row is gone is not', async () => {
      await engine.putPage(CONVERSATION, { type: 'note', title: 'Planning call', compiled_truth: SOURCE_TEXT }, { sourceId: 'default' });
      const id = await insertExtractorFact(engine, ABS_DAMAGED, 3);
      const other = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
        VALUES ('default', NULL, $1, 'fact', 'private', 'mcp:put_page', 4, $2) RETURNING id`, [EXOS_DAMAGED, CONVERSATION]))[0].id);
      const preview = await repair(engine, []);
      const listed = Object.fromEntries(preview.results[0].listing!.map(l => [Number(l.item.split('#')[1]), l.class]));
      expect(listed[id]).toBe('evidenced');
      expect(listed[other]).not.toBe('evidenced');
      expect((await repair(engine, applyArgs(preview))).results[0].outcomes).toEqual({ restored: 1 });
      expect(await extractorRow(engine, id)).toEqual({ fact: ABS_RESTORED, row_num: 3, source_markdown_slug: CONVERSATION, active: true });
      expect((await factText(engine, other)).fact).toBe(EXOS_DAMAGED);
      await engine.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [[id, other]]);
    }, 120_000);

    test('the publication rewrites a row only while it is exactly as previewed (a change after the recheck wins)', async () => {
      const id = Number((await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, context)
        VALUES ('default', $1, $2, 'fact', 'private', 'sync:import', $3) RETURNING id`, [ACME, EXOS_DAMAGED, NOTES]))[0].id);
      const approved = { id, from: EXOS_DAMAGED, to: EXOS_RESTORED, visibility: 'private', entity_slug: ACME, source_markdown_slug: null };
      await engine.executeRaw("UPDATE facts SET visibility='world' WHERE id=$1", [id]);
      expect(await engine.transaction(tx => restoreRedactedRows(tx, 'default', [approved]))).toEqual([]);
      expect((await factText(engine, id)).fact).toBe(EXOS_DAMAGED);
      const updated = await engine.transaction(tx => restoreRedactedRows(tx, 'default', [{ ...approved, visibility: 'world' }]));
      expect(updated.map(r => Number(r.id))).toEqual([id]);
      expect((await factText(engine, id)).fact).toBe(EXOS_RESTORED);
    }, 120_000);
  });
}
