/**
 * D-24 (#7013): atoms a managed re-extraction retired when its model returned no atoms (`retired_by: managed-reextract`)
 * are restorable, preview-first, with `gbrain repair atoms-restore`, and the purge holds them meanwhile.
 *
 * Protects: (a) the preview lists exactly the latest retired generation of a live origin that no later extraction
 * replaced, and never an older generation a later non-empty extraction replaced, an atom with a live replacement, a
 * `stale-atoms` retirement or an atom whose origin page is gone; (b) `--apply` without `--expect` refuses, and the
 * apply restores exactly the previewed set live with frontmatter free of `retired_by`/`retired_at` (managed: the
 * canonical file is back and each outcome names its committed request id), an atom a later extraction replaced after
 * the preview reports `changed_since_preview` and stays deleted, and a second preview is empty; (c) a restorable atom
 * older than the 72 h purge window survives the unmanaged bulk purge and the managed purge selection while a plain
 * tombstone of the same age is purged, and the hold ends 30 days after deletion; (d) doctor
 * `atom_retirements_restorable` warns with the count and the read-only preview and is ok after the restore, and the
 * kind is explicit-only (the runner refuses it unnamed; the remediation classifies its finding explicit_kind_required).
 * Fails when: an empty extraction's retirements are not restorable, the purge removes them inside the hold, or the
 * restore revives a replaced generation or leaves the retirement stamp.
 * Seeds: real managed atoms from extract_atoms (stub chat, `_pages` seam) retired the way prepareManagedAtomMutation
 * retires them (a coordinated soft delete, then the retired_by/retired_at stamp); the unmanaged arm seeds the same rows
 * directly. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { OperationError, type OperationContext } from '../../src/core/ops/contract.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { selectPurgeCandidates, purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { ATOM_RETIRED_BY_REEXTRACT } from '../../src/core/persistence/atom-maintenance.ts';
import { ATOM_REEXTRACT_RETIRED_BY } from '../../src/core/persistence/atom-retirement-hold.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { atomsRestoreRepair } from '../../src/core/repair/atoms-restore.ts';
import { explicitRepairNotices, repairSpec } from '../../src/core/repair/registry.ts';
import { atomRetirementsRestorableCheck } from '../../src/commands/doctor/checks/atom-retirements.ts';
import { runWaveChecks } from '../../src/commands/doctor/wave-checks.ts';
import { classifyWaveFindings } from '../../src/commands/doctor/remediate.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedSource, type ManagedSource } from './managed-fixture.ts';
import { pathologicalArms } from './harness.ts';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; skipped: number;
  listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number>;
  outcome_items?: Array<{ item: string; outcome: string; detail?: { request_id?: string } }> }> }

const prose = (label: string) => `${label}: the acme-example team agreed to measure every launch against clear exit criteria. `.repeat(20);
const page = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\n${body}\n`;
const quiet = { info() {}, warn() {}, error() {} };

async function repair(engine: BrainEngine, sourceId: string, args: string[] = []): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['atoms-restore', '--source', sourceId, ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const hashOf = (json: RepairJson) => json.results[0].apply_command.match(/--expect ([0-9a-f]+)/)![1];

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const atomRows = (engine: BrainEngine, sourceId: string, origin: string) => engine.executeRaw<{ slug: string; deleted: boolean; frontmatter: Record<string, unknown> }>(
  "SELECT slug, deleted_at IS NOT NULL AS deleted, frontmatter FROM pages WHERE source_id=$1 AND type='atom' AND frontmatter->>'source_slug'=$2 ORDER BY slug",
  [sourceId, origin]);

/** Soft-deletes one atom through the page write path and stamps it exactly as prepareManagedAtomMutation's delete branch does. */
async function retire(engine: BrainEngine, sourceId: string, slug: string, retiredBy = ATOM_REEXTRACT_RETIRED_BY): Promise<void> {
  const ctx: OperationContext = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet };
  const snap = (await engine.readPageSnapshot(slug, { sourceId }))!;
  await submitPageMutation(ctx, { operation: 'delete_page', params: { slug, expected_revision: snap.revision, request_id: randomUUID() } });
  await disposePersistenceConsumer(engine);
  await new Promise(resolve => setTimeout(resolve, 5));
  await rawSeed(engine, () => engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=$4 AND deleted_at IS NOT NULL`, [retiredBy, new Date().toISOString(), sourceId, slug]));
}

/** Runs a seed statement the managed writer guard refuses (the retirement stamp, a backdated deletion) with persistence briefly off. */
async function rawSeed<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  const [{ enabled }] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (!enabled) return fn();
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { return await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}

function chatFor(titles: string[]) {
  return async (): Promise<ChatResult> => ({ text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}.` }))),
    blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
}

async function extract(s: ManagedSource, origin: string, titles: string[]): Promise<void> {
  const current = (await s.engine.getPage(origin, { sourceId: s.sourceId }))!;
  const result = await runPhaseExtractAtoms(s.engine, { sourceId: s.sourceId, _transcripts: [], _chat: chatFor(titles),
    _pages: [{ slug: origin, content: current.compiled_truth, contentHash: current.content_hash! }] });
  await disposePersistenceConsumer(s.engine);
  expect(result.status).toBe('ok');
}

/** An unmanaged brain with one source, run under an isolated GBRAIN_HOME. */
async function unmanagedSource(databaseUrl: string | undefined, run: (engine: BrainEngine, sourceId: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-d24-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        const sourceId = `d24-u-${randomUUID().slice(0, 8)}`;
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
        await run(engine, sourceId);
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Unmanaged seed: a page origin and one retired managed atom per (slug, hash), stamped like the managed retirement. */
async function seedAtom(engine: BrainEngine, sourceId: string, slug: string, frontmatter: Record<string, unknown>, retiredBy?: string): Promise<void> {
  await engine.putPage(slug, { type: 'atom', title: slug, compiled_truth: `Claim ${slug}.`,
    frontmatter: { type: 'atom', managed_extraction: true, ...frontmatter } }, { sourceId });
  if (!retiredBy) return;
  await engine.softDeletePage(slug, { sourceId });
  await new Promise(resolve => setTimeout(resolve, 5));
  await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=$4`, [retiredBy, new Date().toISOString(), sourceId, slug]);
}

const backdate = (engine: BrainEngine, sourceId: string, slug: string, hours: number) => rawSeed(engine, () => engine.executeRaw(
  `UPDATE pages SET deleted_at=now() - ($3 || ' hours')::interval WHERE source_id=$1 AND slug=$2`, [sourceId, slug, String(hours)]));

test('D-24 the restore rule keys on the stamp the managed retirement writes', () => {
  expect(ATOM_REEXTRACT_RETIRED_BY).toBe(ATOM_RETIRED_BY_REEXTRACT);
});

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-24 atoms-restore (${backend})`, () => {
    test('D-24 managed: the preview lists the latest retired generation only, the apply restores it with its file and a replaced one stays deleted', async () => {
      await managedSource(databaseUrl, async s => {
        for (const slug of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) await s.put(`notes/${slug}-example`, page(`${slug} example`, prose(`${slug} one`)));
      }, async s => {
        const { engine, sourceId, root } = s;
        // alpha: generation one replaced by a non-empty extraction (generation two), which an empty re-extraction then retired.
        await extract(s, 'notes/alpha-example', ['Alpha first claim', 'Alpha second claim']);
        await s.put('notes/alpha-example', page('alpha example', prose('alpha two')));
        await extract(s, 'notes/alpha-example', ['Alpha replacement claim']);
        const alphaLive = (await atomRows(engine, sourceId, 'notes/alpha-example')).filter(row => !row.deleted);
        expect(alphaLive.length).toBe(1);
        await s.put('notes/alpha-example', page('alpha example', prose('alpha three')));
        await retire(engine, sourceId, alphaLive[0]!.slug);
        // beta: retired by a non-empty extraction whose atom is live (a replacement).
        await extract(s, 'notes/beta-example', ['Beta first claim']);
        await s.put('notes/beta-example', page('beta example', prose('beta two')));
        await extract(s, 'notes/beta-example', ['Beta replacement claim']);
        // gamma: retired by an empty extraction, then its origin page was deleted.
        await extract(s, 'notes/gamma-example', ['Gamma claim']);
        await retire(engine, sourceId, (await atomRows(engine, sourceId, 'notes/gamma-example'))[0]!.slug);
        const gammaPage = (await engine.readPageSnapshot('notes/gamma-example', { sourceId }))!;
        await submitPageMutation({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet },
          { operation: 'delete_page', params: { slug: 'notes/gamma-example', expected_revision: gammaPage.revision, request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        // delta: a stale-atoms retirement.
        await extract(s, 'notes/delta-example', ['Delta claim']);
        await retire(engine, sourceId, (await atomRows(engine, sourceId, 'notes/delta-example'))[0]!.slug, 'stale-atoms');
        // epsilon: both atoms retired by an empty extraction; a later non-empty extraction will replace them after the preview.
        await extract(s, 'notes/epsilon-example', ['Epsilon first claim', 'Epsilon second claim']);
        for (const row of await atomRows(engine, sourceId, 'notes/epsilon-example')) await retire(engine, sourceId, row.slug);

        const alpha = alphaLive[0]!.slug;
        const epsilon = (await atomRows(engine, sourceId, 'notes/epsilon-example')).map(row => row.slug);
        expect(existsSync(join(root, `${alpha}.md`))).toBe(false);
        const doctor = await atomRetirementsRestorableCheck(engine, [sourceId]);
        expect(doctor.status).toBe('warn');
        expect(doctor.details).toMatchObject({ count: 3, origins: 2, source_ids: [sourceId] });
        expect(doctor.message).toContain(`gbrain repair atoms-restore --source ${sourceId} --json`);
        expect((doctor.fix as { argv: string[] }).argv).toEqual(['gbrain', 'repair', 'atoms-restore', '--source', sourceId, '--json']);

        const preview = await repair(engine, sourceId);
        expect(preview.results[0].listing!.map(entry => entry.item).sort()).toEqual([alpha, ...epsilon].map(slug => `${sourceId}:${slug}`).sort());
        expect(preview.results[0].listing!.find(entry => entry.item === `${sourceId}:${alpha}`)!.detail).toMatch(/^origin page notes\/alpha-example, hash [0-9a-f]{16}, retired \d{4}-/);
        expect(preview.results[0].residuals).toEqual({ restorable: 3, origins: 2, origin_gone: 1, replaced: 1, older_generation: 2 });
        const unbound = await refusal(() => repair(engine, sourceId, ['--apply']));
        expect(unbound.toJSON()).toMatchObject({ error: 'invalid_params', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' });

        await s.put('notes/epsilon-example', page('epsilon example', prose('epsilon two')));
        await extract(s, 'notes/epsilon-example', ['Epsilon replacement claim']);
        const applied = await repair(engine, sourceId, ['--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0]).toMatchObject({ applied: 1, skipped: 2, outcomes: { restored: 1, changed_since_preview: 2 } });
        const restoredItem = applied.results[0].outcome_items!.find(entry => entry.item === `${sourceId}:${alpha}`)!;
        expect(restoredItem.outcome).toBe('restored');
        const [request] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1', [restoredItem.detail!.request_id]);
        expect(request?.state).toBe('committed');

        const restored = (await atomRows(engine, sourceId, 'notes/alpha-example')).find(row => row.slug === alpha)!;
        expect(restored.deleted).toBe(false);
        expect(restored.frontmatter).not.toHaveProperty('retired_by');
        expect(restored.frontmatter).not.toHaveProperty('retired_at');
        const file = readFileSync(join(root, `${alpha}.md`), 'utf8');
        expect(file).toContain('Body for Alpha replacement claim.');
        expect(file).not.toContain('retired_by');
        for (const slug of epsilon) expect((await atomRows(engine, sourceId, 'notes/epsilon-example')).find(row => row.slug === slug)!.deleted).toBe(true);
        for (const row of (await atomRows(engine, sourceId, 'notes/alpha-example')).filter(row => row.slug !== alpha)) expect(row.deleted).toBe(true);

        expect((await repair(engine, sourceId)).results[0].affected).toBe(0);
        expect((await atomRetirementsRestorableCheck(engine, [sourceId])).status).toBe('ok');
      });
    }, 300_000);

    test('D-24 managed purge selection holds a restorable atom past 72 h and purges a plain tombstone of the same age', async () => {
      await managedSource(databaseUrl, async s => {
        for (const slug of ['held', 'expired', 'plain']) await s.put(`notes/${slug}-example`, page(`${slug} example`, prose(slug)));
      }, async s => {
        const { engine, sourceId } = s;
        await extract(s, 'notes/held-example', ['Held claim']);
        await extract(s, 'notes/expired-example', ['Expired claim']);
        const [held] = await atomRows(engine, sourceId, 'notes/held-example');
        const [expired] = await atomRows(engine, sourceId, 'notes/expired-example');
        await retire(engine, sourceId, held!.slug);
        await retire(engine, sourceId, expired!.slug);
        const plain = (await engine.readPageSnapshot('notes/plain-example', { sourceId }))!;
        await submitPageMutation({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet },
          { operation: 'delete_page', params: { slug: 'notes/plain-example', expected_revision: plain.revision, request_id: randomUUID() } });
        await disposePersistenceConsumer(engine);
        await backdate(engine, sourceId, held!.slug, 96);
        await backdate(engine, sourceId, 'notes/plain-example', 96);
        await backdate(engine, sourceId, expired!.slug, 31 * 24);
        const selection = await selectPurgeCandidates(engine, 72);
        const slugs = selection.candidates.filter(candidate => candidate.source_id === sourceId).map(candidate => candidate.slug).sort();
        expect(slugs).toEqual([expired!.slug, 'notes/plain-example'].sort());
      });
    }, 300_000);

    test('D-24 unmanaged: preview, apply, changed_since_preview, purge hold, doctor and the explicit-only kind', async () => {
      await unmanagedSource(databaseUrl, async (engine, sourceId) => {
        await engine.putPage('notes/alpha-example', { type: 'note', title: 'Alpha', compiled_truth: prose('alpha') }, { sourceId });
        await engine.putPage('notes/beta-example', { type: 'note', title: 'Beta', compiled_truth: prose('beta') }, { sourceId });
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/alpha-old', { source_slug: 'notes/alpha-example', source_hash: 'pending:1111111111111111' }, ATOM_REEXTRACT_RETIRED_BY);
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/alpha-new', { source_slug: 'notes/alpha-example', source_hash: 'pending:2222222222222222' }, ATOM_REEXTRACT_RETIRED_BY);
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/beta', { source_slug: 'notes/beta-example', source_hash: 'pending:3333333333333333' }, ATOM_REEXTRACT_RETIRED_BY);
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/transcript', { source_path: '/transcripts/acme-example.txt', source_hash: 'pending:4444444444444444' }, ATOM_REEXTRACT_RETIRED_BY);
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/imported', { source_slug: 'notes/beta-example', source_hash: 'pending:5555555555555555', imported_from: 'brain-export' }, ATOM_REEXTRACT_RETIRED_BY);
        await seedAtom(engine, sourceId, 'atoms/2026-01-01/orphan', { source_slug: 'notes/never-existed', source_hash: 'pending:6666666666666666' }, ATOM_REEXTRACT_RETIRED_BY);

        const scope = await resolveRepairScope(engine, sourceId);
        const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: true, remote: false } as unknown as OperationContext;
        expect((await refusal(() => runRepair(ctx, atomsRestoreRepair, scope, { apply: false }))).toJSON()).toMatchObject({ error: 'explicit_kind_required' });
        expect(repairSpec('atoms-restore')).toMatchObject({ explicit_only: true, preview_bound: true, checks: ['atom_retirements_restorable'] });
        expect(explicitRepairNotices().map(notice => notice.kind)).toContain('atoms-restore');
        const waves = (await runWaveChecks(engine, { sourceIds: [sourceId] })).filter(finding => finding.spec.id === 'atom_retirements_restorable');
        expect(classifyWaveFindings([], waves, { repairs: [], repairs_skipped: [] })).toEqual([expect.objectContaining({
          check_id: 'atom_retirements_restorable', class: 'explicit_kind_required', repair_kind: 'atoms-restore', command: `gbrain repair atoms-restore --source ${sourceId}` })]);

        await engine.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'A plain page.' }, { sourceId });
        await engine.softDeletePage('notes/plain-example', { sourceId });
        await backdate(engine, sourceId, 'notes/plain-example', 96);
        await backdate(engine, sourceId, 'atoms/2026-01-01/beta', 96);
        expect((await engine.purgeDeletedPages(72, { dryRun: true })).slugs).toEqual(['notes/plain-example']);
        const purged = await purgeDeletedPagesCoordinated(engine, 72);
        expect(purged.slugs).toEqual(['notes/plain-example']);
        expect((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'atoms/2026-01-01/beta'])).length).toBe(1);

        const preview = await repair(engine, sourceId);
        expect(preview.results[0].listing!.map(entry => entry.item)).toEqual(['alpha-new', 'beta', 'transcript'].map(slug => `${sourceId}:atoms/2026-01-01/${slug}`));
        expect(preview.results[0].residuals).toEqual({ restorable: 3, origins: 3, origin_gone: 1, replaced: 0, older_generation: 1 });
        await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter||'{"retired_at":"2030-01-01T00:00:00.000Z"}'::jsonb WHERE source_id=$1 AND slug=$2`,
          [sourceId, 'atoms/2026-01-01/transcript']);
        const applied = await repair(engine, sourceId, ['--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0]).toMatchObject({ applied: 2, skipped: 1, outcomes: { restored: 2, changed_since_preview: 1 } });
        const rows = await engine.executeRaw<{ slug: string; deleted: boolean; frontmatter: Record<string, unknown> }>(
          "SELECT slug, deleted_at IS NOT NULL AS deleted, frontmatter FROM pages WHERE source_id=$1 AND type='atom' ORDER BY slug", [sourceId]);
        const bySlug = new Map(rows.map(row => [row.slug.replace('atoms/2026-01-01/', ''), row]));
        for (const slug of ['alpha-new', 'beta']) {
          expect(bySlug.get(slug)!.deleted).toBe(false);
          expect(bySlug.get(slug)!.frontmatter).not.toHaveProperty('retired_by');
          expect(bySlug.get(slug)!.frontmatter).not.toHaveProperty('retired_at');
        }
        for (const slug of ['alpha-old', 'transcript', 'imported', 'orphan']) expect(bySlug.get(slug)!.deleted).toBe(true);
        expect((await atomRetirementsRestorableCheck(engine, [sourceId])).details).toMatchObject({ count: 1 });
        const again = await repair(engine, sourceId);
        expect(again.results[0].listing!.map(entry => entry.item)).toEqual([`${sourceId}:atoms/2026-01-01/transcript`]);
        await repair(engine, sourceId, ['--apply', '--expect', hashOf(again)]);
        expect((await repair(engine, sourceId)).results[0].affected).toBe(0);
        expect((await atomRetirementsRestorableCheck(engine, [sourceId])).status).toBe('ok');
      });
    }, 300_000);
  });
}
