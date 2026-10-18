/**
 * Synthetic brain for the batched `gbrain extract all --source db` walk
 * (GBRA-69): enough pages for several 100-page batches across two sources,
 * with every derived row the walk writes (markdown, wikilink and typed links,
 * meeting attendance, stated relation lines with validity ranges, dated
 * transitions, wanted links, timeline bullets, headers and citations), plus
 * the pages it must leave alone (quarantined, a manual link, another
 * source's duplicate slug) and a withdrawn fact the snapshot overlays.
 *
 * `extractDbState` dumps those tables row by row on natural keys (slugs, not
 * ids; timestamps reduced to presence), so a dump captured before the change
 * pins the state after it. Shared by the PGLite test and the Postgres E2E.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { normalizeLoweredClaim } from '../../src/core/facts/withdrawal-schema.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { defineNormalizer, sha256 } from './golden.ts';

export const NOTES_SOURCE = 'notes-example';

const person = (i: number) => `people/person-${i}-example`;
const company = (i: number) => `companies/company-${i}-example`;
const day = (i: number) => `2026-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`;

const FACTS_FENCE = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n'
  + '| 1 | Ships weekly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n'
  + '| 2 | Hires slowly | fact | 1.0 | world | high | 2026-01-01 |  | remember |  |\n<!--- gbrain:facts:end -->';

function personBody(i: number, round: number): { compiled_truth: string; timeline: string } {
  const peer = person((i + 1 + round) % 60);
  const lines = [
    `Person ${i} works closely with [Person](${peer}).`,
    `- works_at [[${company(i % 20)}]]${i % 4 === 0 ? ' @effective[2024-01-01,2025-06-01)' : ''}`,
    i % 5 === 0 ? `Mentioned [[people/missing-${i}-example]] and [[companies/missing-${i % 3}-example]] once.` : '',
    i % 7 === 0 ? '```\n[Not a link](people/person-1-example)\n```' : '',
    i % 9 === 0 ? `Inline \`[[${company(1)}]]\` code stays text. <!-- [Hidden](${person(2)}) -->` : '',
    i % 6 === 0 ? `Shipped the launch with the team [Source: call, ${day(i)}]` : '',
  ].filter(Boolean);
  const timeline = [
    `- **${day(i)}** | meeting — Met [[${peer}]]`,
    i % 3 === 0 ? `- **${day(i + 1)}** | update — Left [Company](${company((i + 1) % 20)}) to join [Company](${company((i + 2) % 20)})` : '',
    i % 8 === 0 ? `- **${day(i + 2)}** | note — Started advises [[${company((i + 3) % 20)}]]` : '',
    round > 0 && i % 2 === 0 ? `- **${day(i + 3)}** | note — Second round entry ${i}` : '',
  ].filter(Boolean).join('\n');
  return { compiled_truth: lines.join('\n\n'), timeline };
}

async function put(engine: BrainEngine, slug: string, type: string, body: { compiled_truth: string; timeline: string },
  frontmatter: Record<string, unknown> = {}, sourceId = 'default') {
  await engine.putPage(slug, { type, title: slug.split('/').pop()!, ...body, frontmatter }, { sourceId });
}

/** Writes the fixture; `round` 1 edits a subset so a second extract replaces and retracts rows. */
export async function seedExtractFixture(engine: BrainEngine, round = 0): Promise<void> {
  if (round === 0) {
    await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES ($1,$1,'{"federated":true}'::jsonb) ON CONFLICT (id) DO NOTHING`, [NOTES_SOURCE]);
    for (let k = 0; k < 20; k++) {
      await put(engine, company(k), 'company', { compiled_truth: `[Person](${person(k)}) is the CEO of [Company](${company(k)}).`
        + (k === 3 ? `\n\n${FACTS_FENCE}` : ''), timeline: '' });
    }
  }
  for (let i = 0; i < 60; i++) {
    if (round > 0 && i % 4 !== 1) continue;
    await put(engine, person(i), 'person', personBody(i, round));
  }
  for (let m = 0; m < 20; m++) {
    if (round > 0 && m % 5 !== 0) continue;
    const attendees = [person(m), person((m + 7 + round) % 60)].map(p => `[Attendee](${p})`).join(', ');
    await put(engine, `meetings/meeting-${m}-example`, 'meeting', { compiled_truth: `Attendees: ${attendees}.\n\n### ${day(m)} — Kickoff ${m}\nDiscussed the plan.`, timeline: '' });
  }
  for (let n = 0; n < 110; n++) {
    if (round > 0 && n % 10 !== 0) continue;
    const quarantine = n === 13 ? { quarantine: { reason: 'synthetic' } } : {};
    await put(engine, `notes/note-${n}-example`, 'note', {
      compiled_truth: `Note ${n} about [[${person(n % 60)}]] and [[${company(n % 20)}]]${round > 0 ? '' : ` and [Person](${person((n + 5) % 60)})`}.`
        + (n % 4 === 0 ? `\n\nWe agreed on terms [Source: email, ${day(n)}]` : ''),
      timeline: n % 3 === 0 ? `- **${day(n)}** | email — Note entry ${n}${round > 0 ? ' revised' : ''}` : '',
    }, quarantine);
  }
  if (round === 0) {
    for (let j = 0; j < 15; j++) {
      await put(engine, j === 0 ? person(0) : `notes/notes-side-${j}-example`, j === 0 ? 'person' : 'note',
        { compiled_truth: `Side ${j} cites [[default:${person(j)}]] and [[${j === 0 ? 'notes/notes-side-1-example' : person(0)}]].`, timeline: `- **${day(j)}** | side — Side entry ${j}` },
        {}, NOTES_SOURCE);
    }
    await engine.addLink(person(1), company(5), 'Manual evidence', 'mentions', 'manual');
    await engine.addTag(person(11), 'founder');
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',$1)`,
      [createHash('sha256').update(normalizeLoweredClaim('ships weekly')).digest('hex')]);
  }
}

const TABLES: Record<string, string> = {
  links: `SELECT jsonb_build_array(f.source_id, f.slug, t.source_id, t.slug, l.link_type, l.link_source, l.link_kind, o.source_id, o.slug,
      l.context, l.origin_field, l.assertion_tense)::text AS r
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id LEFT JOIN pages o ON o.id=l.origin_page_id`,
  timeline_entries: `SELECT jsonb_build_array(p.source_id, p.slug, t.date::text, t.source, t.summary, t.detail, e.slug)::text AS r
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id LEFT JOIN pages e ON e.id=t.event_page_id`,
  link_transitions: `SELECT jsonb_build_array(lt.source_id, f.slug, t.slug, lt.link_type, lt.kind, lt.occurred_on::text, lt.date_precision, lt.producer, o.slug, lt.line_hash)::text AS r
    FROM link_transitions lt JOIN pages f ON f.id=lt.from_page_id JOIN pages t ON t.id=lt.to_page_id LEFT JOIN pages o ON o.id=lt.origin_page_id`,
  link_relationships: `SELECT jsonb_build_array(lr.source_id, f.slug, t.slug, lr.link_type, lr.scope, lr.semantics, lr.valid_ranges::text, lr.status_now,
      lr.first_start::text, lr.last_start::text, lr.last_end::text, lr.undated_present, lr.undated_past, lr.disputed, lr.retired_at IS NULL, lr.evidence_hash)::text AS r
    FROM link_relationships lr JOIN pages f ON f.id=lr.from_page_id JOIN pages t ON t.id=lr.to_page_id`,
  wanted_links: `SELECT jsonb_build_array(o.source_id, o.slug, w.source_id, w.producer, w.ref_kind, w.target_source_id, w.target_ref, w.link_type, w.context,
      w.checked_at = '-infinity'::timestamptz)::text AS r FROM wanted_links w JOIN pages o ON o.id=w.origin_page_id`,
  pages: `SELECT jsonb_build_array(source_id, slug, type, content_hash, links_extracted_at IS NOT NULL, links_attendance_blocked_revision IS NOT NULL,
      deleted_at IS NULL)::text AS r FROM pages`,
  tags: `SELECT jsonb_build_array(p.source_id, p.slug, t.tag)::text AS r FROM tags t JOIN pages p ON p.id=t.page_id`,
  facts: `SELECT jsonb_build_array(source_id, fact, kind, visibility)::text AS r FROM facts`,
  extract_requests: `SELECT jsonb_build_array(operation, state, source_id, slug, error_code)::text AS r FROM persistence_requests
    WHERE operation <> 'put_page' AND operation <> 'put_skill'`,
};

/** Every row the walk writes or must keep, on natural keys, sorted by code unit (collation-independent). */
export async function extractDbState(engine: BrainEngine): Promise<Record<string, string[]>> {
  const state: Record<string, string[]> = {};
  for (const [table, sql] of Object.entries(TABLES)) {
    state[table] = (await engine.executeRaw<{ r: string }>(sql)).map(row => row.r).sort();
  }
  return state;
}

/** `gbrain extract <args>` in process: the parsed --json result and the exit verdict. */
export async function runExtractJson(engine: BrainEngine, args: string[]): Promise<{ result: unknown; exitCode: number }> {
  const out: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = () => {};
  const priorExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  try {
    await runExtract(engine, args);
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = priorExitCode ?? 0;
  }
  const exitCode = currentExitCode();
  _resetCliExitVerdictForTests();
  const text = out.join('\n');
  return { result: JSON.parse(text.slice(text.indexOf('{'))), exitCode };
}

export async function unmanagedRounds(engine: BrainEngine) {
  await seedExtractFixture(engine);
  const first = await runExtractJson(engine, ['all', '--source', 'db', '--json']);
  const afterFirst = await extractDbState(engine);
  await seedExtractFixture(engine, 1);
  const second = await runExtractJson(engine, ['all', '--source', 'db', '--json']);
  return { first, afterFirst, second, afterSecond: await extractDbState(engine) };
}

/** Every 10th seeded page lost its stored timeline rows, so the coordinator writes them back. */
export async function managedRounds(engine: BrainEngine) {
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`DELETE FROM timeline_entries
    WHERE page_id IN (SELECT id FROM pages WHERE source_id = 'default' AND id % 10 = 0)`), TEST_WRITE_ATTRIBUTION));
  const first = await runExtractJson(engine, ['all', '--source', 'db', '--json']);
  const afterFirst = await extractDbState(engine);
  const second = await runExtractJson(engine, ['all', '--source', 'db', '--json']);
  return { first, afterFirst, second, afterSecond: await extractDbState(engine) };
}

/** Make every batch transaction fail, so each batch is replayed page by page. */
export function failEveryBatch(engine: BrainEngine) {
  (engine as { replaceDerivedLinksBatch: unknown }).replaceDerivedLinksBatch = async () => { throw new Error('synthetic batch failure'); };
}

type Rounds = Awaited<ReturnType<typeof unmanagedRounds>>;
/** Each table as its row count and the sha256 of its sorted rows: equal digests are equal rows. */
export const EXTRACT_ROWS = defineNormalizer<Rounds>('extract-db-batch-rows-v1', rounds => ({ ...rounds,
  afterFirst: digests(rounds.afterFirst), afterSecond: digests(rounds.afterSecond) }));
const digests = (state: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(state).map(([table, rows]) => [table, { rows: rows.length, sha256: sha256(rows.join('\n')) }]));
