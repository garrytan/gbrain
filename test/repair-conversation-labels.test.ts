/**
 * `gbrain repair conversation-labels` (wave 9 follow-ups, item 2), on PGLite
 * and, with a safe DATABASE_URL, Postgres
 * (test/e2e/repair-conversation-labels-postgres.test.ts).
 *
 * Protects: facts the pre-v0.60.69 parser extracted from meeting-note labels
 * read as speakers are retired only by a previewed, hash-bound, consented
 * apply that makes no model calls: the epoch-segment rows by default, every
 * other label-page row only with --include-ambiguous; excluded rows
 * (withdrawn, superseded, referenced by superseded_by or an open loop, pages
 * the fixed extractor already scanned) stay active. The apply expires the
 * approved rows and the completion marker, writes the not-extractable outcome
 * for a prose page, and leaves a dated transcript in the extraction backlog
 * with hand-off commands the extraction CLI parses. The chain repair →
 * ordinary extraction → orphan cleanup → extractor-facts repair never
 * deletes or restores a retired or excluded row. A managed brain publishes
 * one receipted request per page. Without consent a non-interactive apply
 * exits 3 and changes nothing; a wrong hash refuses with preview_changed; a
 * live serve's lock refusal names stop → repair → restart.
 * Seams: pre-fix rows are seeded with the extractor's provenance (no
 * gateway), extraction runs the Core with an injected extractor.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { currentConversationVersionToken, parseArgs as parseExtractArgs, runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_LABELS_INTENT, EPOCH_SEGMENT_MARKER } from '../src/core/repair/conversation-labels.ts';
import { classifyExtractorFacts } from '../src/core/repair/extractor-facts.ts';
import { conversationLabelFactsCheck } from '../src/commands/doctor/checks/conversation-outcomes.ts';
import { NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE, outcomeExtractorVersion, stampExtractorVersion } from '../src/core/facts/audit-sources.ts';
import { LiveServeLockError } from '../src/core/pglite-lock.ts';
import { exclusiveFix, liveServeOwner } from '../src/core/exclusive-fix.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SEGMENT = 'cli:extract-conversation-facts';
const PROSE = 'meetings/prose-notes';
const DATED = 'meetings/dated-sync';
const FIXED = 'meetings/fixed-notes';
const epoch = (slug: string) => `from ${slug} ${EPOCH_SEGMENT_MARKER}T00:00:00Z..1970-01-01T00:00:00Z`;

interface Seeded { evidenced: number[]; ambiguous: number[]; excluded: number[]; referencedBy: number; openLoop: number }

async function insert(engine: BrainEngine, slug: string, rows: Array<{ fact: string; context?: string | null; source?: string; session?: string; superseded_by_row?: number }>, start = 0): Promise<number[]> {
  const { ids } = await engine.insertFacts(rows.map((row, i) => ({ fact: row.fact, kind: 'fact' as const, entity_slug: null, visibility: 'private' as const,
    notability: 'medium' as const, confidence: 1, source: row.source ?? SEGMENT, source_session: row.session ?? `${SEGMENT}:${slug}`, context: row.context ?? null,
    row_num: start + i, source_markdown_slug: slug })), { source_id: 'default' });
  return ids;
}

/** Pre-fix extractions as `extract-conversation-facts` left them before the parser fix (plus one page the fixed extractor scanned). */
async function seed(engine: BrainEngine): Promise<Seeded> {
  await engine.putPage(PROSE, { type: 'meeting', title: 'Planning notes', compiled_truth:
    '**Date:** 2026-09-28\n**Attendees:** Alice Example, Bob Example\n\n## Notes\nWe went through hiring and the launch dates.\n\n## Action items\n- Bob sends the plan.' });
  await engine.putPage(DATED, { type: 'meeting', title: 'Dated sync', frontmatter: { date: '2026-09-28' }, compiled_truth:
    '**Date:** 2026-09-28\n**Attendees:** Alice Example, Bob Example\n\n**Alice Example:** Can you send the quarterly plan?\n**Bob Example:** Yes, on Thursday.\n**Alice Example:** Great, I review on Mondays.' });
  await engine.putPage(FIXED, { type: 'meeting', title: 'Fixed notes', compiled_truth: '**Date:** 2026-09-28\n**Attendees:** Alice Example\n\nNotes only.' });
  const prose = await insert(engine, PROSE, [{ fact: 'Date said the review is on Monday', context: epoch(PROSE) },
    { fact: 'Attendees said hiring is open', context: epoch(PROSE) }, { fact: 'The launch moved to Q4', context: 'from the planning notes' },
    { fact: 'EXTRACTION_COMPLETE', source: TERMINAL_AUDIT_SOURCE, session: `${TERMINAL_AUDIT_SOURCE}:${PROSE}:page-old` }]);
  const dated = await insert(engine, DATED, [{ fact: 'Date said the plan is due Thursday', context: epoch(DATED) },
    { fact: 'Bob Example sends the quarterly plan on Thursday', context: `from ${DATED} segment 2026-09-28T00:00:00Z..2026-09-28T00:00:00Z` },
    { fact: 'Attendees said Monday reviews', context: epoch(DATED) }, { fact: 'Summary said plans slip', context: epoch(DATED) },
    { fact: 'EXTRACTION_COMPLETE', source: TERMINAL_AUDIT_SOURCE, session: `${TERMINAL_AUDIT_SOURCE}:${DATED}:page-old` }]);
  // A remembered fact whose superseded_by names one label row; an open loop that points at another.
  const [newer] = await engine.insertFacts([{ fact: 'Reviews moved to Tuesdays', kind: 'fact', entity_slug: null, visibility: 'private', source: 'mcp:remember',
    row_num: 100, source_markdown_slug: DATED }], { source_id: 'default' }).then(r => r.ids);
  await engine.executeRaw('UPDATE facts SET superseded_by=$1 WHERE id=$2', [dated[2], newer]);
  await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, detector, fact_id)
    VALUES ('default', 'label-loop', 'commitment_owed_by_me', 'Summary follow-up', 'manual', $1)`, [dated[3]]);
  const token = await currentConversationVersionToken(engine, (await engine.getPage(FIXED, { sourceId: 'default' }))!);
  const fixed = await insert(engine, FIXED, [{ fact: 'Date said notes only', context: epoch(FIXED) },
    { fact: 'EXTRACTION_NOT_APPLICABLE', source: NON_EXTRACTABLE_AUDIT_SOURCE, session: `${NON_EXTRACTABLE_AUDIT_SOURCE}:${FIXED}:${token}`,
      context: stampExtractorVersion('scanned, not extractable: prose') }]);
  return { evidenced: [prose[0]!, prose[1]!, dated[0]!], ambiguous: [prose[2]!, dated[1]!], excluded: [dated[2]!, dated[3]!, fixed[0]!],
    referencedBy: dated[2]!, openLoop: dated[3]! };
}

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; warnings?: string[];
  listing?: Array<{ item: string; class: string }>; outcomes?: Record<string, number>; outcome_items?: Array<{ item: string; outcome: string; detail?: Record<string, unknown> }>; details?: { handoff?: string[]; pages?: Array<{ slug: string; outcome: string }> } }> }

async function capture(run: () => Promise<unknown>): Promise<{ out: string; exitCode: number | string | undefined }> {
  const lines: string[] = [];
  const { log, error } = console;
  const stdout = process.stdout.write.bind(process.stdout);
  const previous = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  console.error = () => {};
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await run(); return { out: lines.join('\n'), exitCode: process.exitCode }; }
  finally { console.log = log; console.error = error; process.stdout.write = stdout; process.exitCode = previous; }
}
async function repair(engine: BrainEngine, args: string[]): Promise<RepairJson> {
  const { out } = await capture(() => runRepairCommand(engine, ['conversation-labels', ...args, '--json']));
  return JSON.parse(out) as RepairJson;
}
const hashOf = (json: RepairJson) => json.results[0]!.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;
const active = async (engine: BrainEngine, ids: number[]) => (await engine.executeRaw<{ id: number }>(
  'SELECT id FROM facts WHERE id=ANY($1::bigint[]) AND expired_at IS NULL ORDER BY id', [ids])).map(r => Number(r.id));
const existing = async (engine: BrainEngine, ids: number[]) => (await engine.executeRaw<{ id: number }>(
  'SELECT id FROM facts WHERE id=ANY($1::bigint[]) ORDER BY id', [ids])).map(r => Number(r.id));
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

async function exercise(engine: BrainEngine, managed: boolean, seeded: Seeded): Promise<void> {
  expect((await conversationLabelFactsCheck(engine, ['default'])).details).toMatchObject({ evidenced: 3 });
  const preview = await repair(engine, []);
  const result = preview.results[0]!;
  expect(result.residuals).toMatchObject({ evidenced: 3, ambiguous: 2, excluded: 3, non_extractable_pages: 1, awaiting_reextraction_pages: 1 });
  expect(result.warnings).toContain('This command makes no model calls.');
  expect(result.listing!.filter(l => l.class.startsWith('excluded:')).map(l => l.class).sort())
    .toEqual(['excluded:current_extractor', 'excluded:open_loop_reference', 'excluded:superseded_by_reference']);
  expect(result.details!.pages!.map(p => [p.slug, p.outcome]).sort()).toEqual([[DATED, 'awaiting_reextraction'], [PROSE, 'non_extractable']]);
  // Every printed hand-off parses with the extraction command's own parser and names exactly the awaiting page.
  const handoff = result.details!.handoff!;
  expect(handoff).toHaveLength(2);
  for (const command of handoff) {
    const argv = command.replace('<n>', '1').split(' ');
    expect(argv.slice(0, 2)).toEqual(['gbrain', 'extract-conversation-facts']);
    const parsed = parseExtractArgs(argv.slice(2));
    expect(parsed.error).toBeUndefined();
    expect(parsed).toMatchObject({ sourceId: 'default', slugs: [DATED] });
  }
  const hash = hashOf(preview);
  // Wrong hash: preview_changed, nothing changes.
  const wrong = await capture(() => runRepairCommand(engine, ['conversation-labels', '--apply', '--expect', 'f'.repeat(64), '--yes', '--json']))
    .then(r => r.out, (e: Error & { code?: string }) => e.code);
  expect(wrong).toBe('preview_changed');
  // Unapproved non-interactive apply: exit 3 with the database-row consent payload, nothing changes.
  const refused = await capture(() => runRepairCommand(engine, ['conversation-labels', '--apply', '--expect', hash, '--json']));
  expect(refused.exitCode).toBe(3);
  const payload = JSON.parse(refused.out);
  expect(payload).toMatchObject({ code: 'confirmation_required', effects: ['destructive'] });
  expect(JSON.stringify(payload)).toContain('expired, not deleted');
  expect(JSON.stringify(payload)).not.toMatch(/git revert|backups\/frontmatter/);
  expect(await active(engine, seeded.evidenced)).toEqual(sorted(seeded.evidenced));
  // Approved apply: no model call, approved rows expired with the marker, markers expired, prose outcome written.
  const applied = await repair(engine, ['--apply', '--expect', hash, '--yes']);
  // Both pages apply in one batch (one request, one receipt) with their own outcomes.
  expect(applied.results[0]!.outcomes).toEqual({ retired: 1 });
  expect(applied.results[0]!.outcome_items![0]!.detail).toMatchObject({ retired: 3, pages: { [PROSE]: 'non_extractable', [DATED]: 'awaiting_reextraction' } });
  expect(await active(engine, seeded.evidenced)).toEqual([]);
  expect(await active(engine, [...seeded.ambiguous, ...seeded.excluded])).toEqual(sorted([...seeded.ambiguous, ...seeded.excluded]));
  const [retired] = await engine.executeRaw<{ context: string }>('SELECT context FROM facts WHERE id=$1', [seeded.evidenced[0]]);
  expect(retired!.context).toContain('retired: conversation-labels');
  const outcomes = await engine.executeRaw<{ slug: string; fact: string; context: string | null }>(`SELECT source_markdown_slug AS slug, fact, context FROM facts
    WHERE source_id='default' AND source IN ($1,$2) AND expired_at IS NULL ORDER BY slug`, [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);
  expect(outcomes.map(o => [o.slug, o.fact])).toEqual([[FIXED, 'EXTRACTION_NOT_APPLICABLE'], [PROSE, 'EXTRACTION_NOT_APPLICABLE']]);
  expect(outcomeExtractorVersion(outcomes[1]!.context)).toBe(1);
  if (managed) {
    const requests = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE intent->>'kind'=$1", [CONVERSATION_LABELS_INTENT]);
    expect(requests.map(r => r.state)).toEqual(['committed']);
  }
  expect((await conversationLabelFactsCheck(engine, ['default'])).status).toBe('ok');
  // Lifecycle: ordinary extraction re-extracts only the dated page; replacement keeps retired and referenced rows.
  let calls = 0;
  const run = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [PROSE, DATED, FIXED], sleepMs: 0, overrideDisabled: true,
    extractor: async () => { calls++; return [{ fact: 'Bob Example sends the quarterly plan on Thursday', kind: 'commitment', confidence: 0.9, entity_slug: null, source: 'x' }]; } });
  expect(calls).toBe(1);
  expect(run).toMatchObject({ pages_processed: 1, pages_skipped_non_extractable: 2, pages_failed: 0 });
  const kept = [...seeded.evidenced, ...seeded.excluded];
  expect(await existing(engine, kept)).toEqual(sorted(kept));
  expect(await active(engine, [seeded.openLoop, seeded.referencedBy])).toEqual([]);
  // extractor-facts never restores a retired row.
  const restorable = await classifyExtractorFacts(engine, ['default'], { managed });
  expect(restorable.filter(f => kept.includes(f.id))).toEqual([]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: managed brain: preview, consent, approved expiry and the lifecycle chain`, async () => {
    let seeded!: Seeded;
    await managedBrain(async ({ engine }) => exercise(engine, true, seeded), { databaseUrl, setup: async ({ engine }) => { seeded = await seed(engine); } });
  }, 180_000);
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

test('pglite: unmanaged brain: the same preview, consent and expiry, written under the page lock', async () => {
  await exercise(engine, false, await seed(engine));
}, 180_000);

test('--include-ambiguous widens the hashed set to every label-page row', async () => {
  const seeded = await seed(engine);
  const preview = await repair(engine, ['--include-ambiguous']);
  expect(preview.results[0]!.apply_command).toContain('--include-ambiguous');
  const mismatched = await capture(() => runRepairCommand(engine, ['conversation-labels', '--apply', '--expect', hashOf(preview), '--yes', '--json']))
    .then(r => r.out, (e: Error & { code?: string }) => e.code);
  expect(mismatched).toBe('preview_changed');
  await repair(engine, ['--include-ambiguous', '--apply', '--expect', hashOf(preview), '--yes']);
  expect(await active(engine, [...seeded.evidenced, ...seeded.ambiguous])).toEqual([]);
  expect(await active(engine, seeded.excluded)).toEqual(sorted(seeded.excluded));
}, 180_000);

test('under a live serve the refusal names stop → repair → restart', () => {
  // acquireLock throws LiveServeLockError at once for a live serve holder (no 30 s wait);
  // the fatal CLI seam wraps the rerun in this two-step plan.
  const error = new LiveServeLockError('GBrain\'s local database is already open through `gbrain serve`.', { pid: 4242, transport: 'stdio' });
  const argv = ['gbrain', 'repair', 'conversation-labels', '--apply', '--expect', 'abc', '--yes', '--json'];
  const fix = exclusiveFix({ argv, consent: [], actor: 'agent', requires_exclusive: true, why: 'Re-runs this command once it has the brain to itself.' }, liveServeOwner(error));
  expect(fix).toMatchObject({ argv: ['kill', '4242'], actor: 'user', then: { argv } });
  expect(fix.why).toContain('Reopen the agent session');
});
