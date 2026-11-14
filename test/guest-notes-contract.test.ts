/**
 * Guest notes, slice 3 (GBRA-504), the G3 contract: no op returns a guest page's text without the guest warning.
 *
 * Protects: every op in OPERATION_MANIFEST that may return stored text (outputRedaction other than no_stored_text) is
 * classified here, and every classified read is dispatched through MCP with one seeded guest page reachable, as the
 * owner over HTTP, as the owner over stdio, and as the audience member over HTTP. Wherever the guest page's text shows
 * up, its JSON object (or an enclosing one) carries origin "guest" and a guest object equal to the page's guest_marks
 * row (the writer only for owner callers), and a text block carries the warning line. A new op that may return stored
 * text and is not classified fails the test. The local CLI's read verbs, rendered as the CLI renders them for the
 * owner, carry the warning line.
 *
 * Non-op surfaces (F8), each covered elsewhere or empty by construction: hot memory and its notices carry facts only,
 * and guest pages make no facts (decision I, guest-notes-admission.test.ts); MCP resources serve skill files through
 * the skill ops classified below; always-load injection reads pages whose frontmatter sets always_load, which guest
 * frontmatter refuses (guest_frontmatter_refused); export writes markdown files for the owner on the host and is not
 * an agent read (F17, informational, not adopted).
 *
 * Real seams: legacy tokens bound by the member functions, MCP dispatch on a repo-less PGLite brain, the CLI's own
 * formatters.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { changeGuestWriters, initGuestSource } from '../src/core/guests/sources.ts';
import { guestWarningLine, type GuestStamp } from '../src/core/guests/marker.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { formatResult } from '../src/cli/main.ts';
import { withGuestLines } from '../src/cli/guest-lines.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const GUEST = 'notes/guest-contract';
const SENTINEL = 'zephyrquill';
/** Text only the guest page holds (its title and body), never an argument a call echoes back. */
const GUEST_TEXT = [SENTINEL + ' note', 'offsite moved to Friday'];
const holdsGuestText = (s: string) => GUEST_TEXT.some(t => s.includes(t));
const TODAY = new Date().toISOString().slice(0, 10);

type Args = Record<string, unknown>;
const skip = (reason: string) => ({ skip: reason });
const JOBS = 'job and watch bookkeeping: ids, states, params and results, never page text';
const SKILLS = 'skill catalog files read verbatim, never pages';
const WRITE = 'a write refused on a guest source (source_writer_restricted or guest_page_immutable); it never returns a guest page';
const MODEL = 'needs a paid model call; guest pages are excluded from synthesis and extraction inputs (decision I), and think is covered with a stub model in guest-notes-warning.test.ts';
/** Every op that may return stored text: the arguments a read is dispatched with, or why it is not dispatched. */
const CLASSIFIED: Record<string, Args | { skip: string }> = {
  entity: { name: GUEST, source_id: SRC },
  synthesize: skip(MODEL),
  get_page: { slug: GUEST },
  list_pages: { source_ids: [SRC, PLAIN] },
  fetch: { id: GUEST },
  find_pages: { pattern: 'notes/*' },
  edit_page: skip(WRITE),
  search: { query: SENTINEL, source_ids: [SRC, PLAIN] },
  query: { query: SENTINEL, source_ids: [SRC, PLAIN] },
  assemble_evidence: { hits: [{ slug: GUEST, source_id: SRC }] },
  search_exact: { phrase: SENTINEL },
  search_by_image: skip('searches image pages by an image; a guest note has no image'),
  get_links: { slug: GUEST },
  get_backlinks: { slug: GUEST },
  traverse_graph: { slug: GUEST },
  wanted_pages: {},
  add_timeline_entry: skip(WRITE),
  get_timeline: { slug: GUEST },
  get_versions: { slug: GUEST, include_body: true },
  quarantine_list: {},
  get_skill: skip(SKILLS), list_brain_skillpack: skip(SKILLS), get_skill_asset: skip(SKILLS), sync_brain_skills: skip(SKILLS), run_skillopt: skip(SKILLS),
  advisor: {},
  get_raw_data: { slug: GUEST },
  get_chunks: { slug: GUEST },
  whois: { query: SENTINEL },
  get_ingest_log: {},
  submit_job: skip(JOBS), get_job: skip(JOBS), wait_job: skip(JOBS), list_jobs: skip(JOBS), cancel_job: skip(JOBS), retry_job: skip(JOBS),
  get_job_progress: skip(JOBS), pause_job: skip(JOBS), resume_job: skip(JOBS), replay_job: skip(JOBS), send_job_message: skip(JOBS),
  submit_agent: skip(JOBS), get_agent_job: skip(JOBS), watch_job: skip(JOBS), list_watches: skip(JOBS), unwatch: skip(JOBS),
  find_orphans: {},
  rank_entities: {},
  get_calibration_profile: {},
  takes_list: {},
  takes_search: { query: SENTINEL },
  think: skip(MODEL),
  takes_rebuild: skip(WRITE),
  get_recent_salience: {},
  find_anomalies: {},
  get_recent_transcripts: {},
  chronicle_day: { date: TODAY },
  chronicle_on_this_day: {},
  chronicle_since: { date: '2026-01-01' },
  chronicle_last_seen: { entity: GUEST },
  ontology_get: { entity: GUEST },
  ontology_propose: skip(WRITE),
  ontology_conflicts: {},
  volunteer_chronicle: {},
  volunteer_context: { window: 'Tell me about ' + SENTINEL },
  extract_entities: skip(MODEL),
  extraction_pending: {},
  recall: { query: SENTINEL, source_ids: [SRC, PLAIN] },
  context_pack: { entities: [GUEST] },
  delta: { since: '2026-01-01' },
  memory_recall: { query: SENTINEL },
  find_contradictions: { slug: GUEST },
  find_experts: { topic: SENTINEL },
  find_trajectory: { entity_slug: GUEST },
  code_callers: { symbol: SENTINEL }, code_callees: { symbol: SENTINEL }, code_def: { symbol: SENTINEL }, code_refs: { symbol: SENTINEL },
  code_blast: { symbol: SENTINEL }, code_flow: { entry_point: SENTINEL },
  open_loops: {},
  questions_pin: skip(WRITE), questions_refresh: skip(WRITE), questions_unpin: skip(WRITE),
  questions_list: {},
  questions_status: { id: 'q-1' },
};
/** Reads whose owner answer must contain the guest page's text, so the contract is exercised, not vacuous. */
const MUST_REACH = ['get_page', 'list_pages', 'find_pages', 'search', 'query', 'search_exact', 'get_chunks', 'fetch'];

let engine: PGLiteEngine;
const tokens: Record<string, { id: string; token: string }> = {};
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;
let expected: GuestStamp;

type Caller = 'owner-http' | 'owner-stdio' | 'audience-http';
async function dispatchAs(caller: Caller, op: string, args: Args) {
  const base = { sourceId: SRC, takesHoldersAllowList: ['world'] };
  const out = caller === 'owner-stdio'
    ? await dispatchToolCall(engine, op, (({ source_ids: _s, ...rest }) => rest)(args), { ...base, remote: true, transport: 'stdio', stdioMember: OWNER })
    : await dispatchToolCall(engine, op, { ...args }, { ...base, remote: true, transport: 'http', auth: await verify(caller === 'owner-http' ? 'owner' : 'bob') });
  return out.content.map(c => c.text);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Every place the sentinel appears in a JSON value, with the guest object of its nearest marked self-or-ancestor (or null). */
function sentinelSpots(v: unknown, marked: unknown = null, path = '$', out: Array<{ path: string; guest: unknown; text: string }> = []) {
  if (typeof v === 'string') { if (holdsGuestText(v)) out.push({ path, guest: marked, text: v }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => sentinelSpots(x, marked, path + '[' + i + ']', out)); return out; }
  if (!isObj(v)) return out;
  const here = v.origin === 'guest' && isObj(v.guest) ? v.guest : marked;
  for (const [k, x] of Object.entries(v)) if (k !== 'guest') sentinelSpots(x, here, path + '.' + k, out);
  return out;
}

/** Violations in one answer: sentinel text without the guest stamp, or a stamp whose fields differ from guest_marks. */
function violations(blocks: string[], owner: boolean): string[] {
  const want = owner ? expected : (({ writer: _w, ...rest }) => rest)(expected);
  const bad: string[] = [];
  blocks.forEach((text, i) => {
    if (!holdsGuestText(text)) return;
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (json === undefined) {
      if (!text.includes(guestWarningLine(want))) bad.push('block ' + i + ': text without the warning line');
      return;
    }
    for (const spot of sentinelSpots(json)) {
      if (spot.guest === null && spot.text.includes(guestWarningLine({ ...want, writer: undefined }))) continue;
      if (spot.guest === null) bad.push('block ' + i + ' ' + spot.path + ': guest text without origin guest');
      else if (JSON.stringify(spot.guest) !== JSON.stringify(want)) bad.push('block ' + i + ' ' + spot.path + ': guest object ' + JSON.stringify(spot.guest) + ' differs from guest_marks');
    }
  });
  return bad;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example']) await addMember(engine, id);
  await addGroup(engine, 'team-a', ['bob-example']);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await importFromContent(engine, 'notes/owner-plan', '---\ntype: note\ntitle: Owner plan\n---\n# Owner plan\n\nThe owner plans the harbor review.\n', { sourceId: PLAIN });
  await initGuestSource(engine, SRC, []);
  const mint = async (name: string, grant: string[], binding: { member?: string; mayActFor?: string[] }) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: grant });
    tokens[name] = { id: minted.id, token: minted.token };
    await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
    if (!binding.member) await readsUnscopedOnPurpose(engine, minted.id);
  };
  await mint('broker', [SRC], { mayActFor: ['member:bob-example'] });
  await mint('owner', [SRC, PLAIN], { member: OWNER });
  await mint('bob', [SRC], { member: 'bob-example' });
  await changeGuestWriters(engine, SRC, { add: ['legacy_token:' + tokens.broker!.id] });
  const content = ['---', 'type: note', 'title: ' + SENTINEL + ' note', 'readable_by: [' + OWNER + ', bob-example]', 'guest_group: team-a', 'guest_sender: Bob Example',
    'saved_at: 2026-11-13T10:00:00Z', '---', '# ' + SENTINEL + ' note', '', 'Bob says the ' + SENTINEL + ' offsite moved to Friday.'].join('\n');
  const put = await dispatchToolCall(engine, 'put_page', { slug: GUEST, content }, { remote: true, transport: 'http', auth: await verify('broker'), sourceId: SRC,
    takesHoldersAllowList: ['world'], onBehalfOf: { header: 'bob-example' }, guest: { requestMeta: { guest: { sender_label: 'Bob Example', group: 'team-a' } } } });
  expect(put.isError).not.toBe(true);
  const [m] = await engine.executeRaw<{ sender_label: string; group_slug: string; audience_member: string; saved_at: Date | string; writer_kind: string; writer_id: string }>(
    'SELECT m.* FROM guest_marks m JOIN pages p ON p.id = m.page_id WHERE p.source_id = $1 AND p.slug = $2', [SRC, GUEST]);
  expected = { sender_label: m!.sender_label, group: m!.group_slug, audience_member: m!.audience_member, saved_at: new Date(m!.saved_at).toISOString().slice(0, 10),
    promoted: false, writer: m!.writer_kind + ':' + m!.writer_id };
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('G3: every op that returns stored text carries the guest warning', () => {
  const storedText = (OPERATION_MANIFEST as ReadonlyArray<{ name: string; outputRedaction: unknown }>).filter(o => o.outputRedaction !== 'no_stored_text').map(o => o.name);

  test('every op that may return stored text is classified, and nothing classified is stale', () => {
    expect(storedText.filter(name => !(name in CLASSIFIED))).toEqual([]);
    expect(Object.keys(CLASSIFIED).filter(name => !storedText.includes(name))).toEqual([]);
  });

  for (const caller of ['owner-http', 'owner-stdio', 'audience-http'] as Caller[]) {
    test(caller + ': no answer shows the guest page without its warning', async () => {
      const bad: string[] = [];
      const reached: string[] = [];
      for (const name of storedText) {
        const entry = CLASSIFIED[name];
        if (!entry || 'skip' in entry) continue;
        const blocks = await dispatchAs(caller, name, entry as Args);
        if (blocks.some(holdsGuestText)) reached.push(name);
        for (const v of violations(blocks, caller !== 'audience-http')) bad.push(name + ': ' + v);
      }
      expect(bad).toEqual([]);
      if (caller !== 'audience-http') expect(MUST_REACH.filter(name => !reached.includes(name))).toEqual([]);
      else expect(reached).toContain('get_page');
    }, 240_000);
  }

  test('the local CLI read verbs print the warning line beside the guest text', async () => {
    const line = guestWarningLine(expected);
    const bad: string[] = [];
    for (const [op, args] of [['get_page', { slug: GUEST }], ['list_pages', { source_id: SRC }], ['find_pages', { pattern: 'notes/*' }], ['search', { query: SENTINEL }],
      ['search_exact', { phrase: SENTINEL }], ['get_chunks', { slug: GUEST }], ['get_versions', { slug: GUEST, include_body: true }]] as Array<[string, Args]>) {
      const out = await dispatchToolCall(engine, op, { ...args }, { remote: false, sourceId: SRC });
      const result = JSON.parse(out.content[0]!.text);
      const text = withGuestLines(op, result, {}, formatResult(op, result, {}));
      if (holdsGuestText(text) && !text.includes(line)) bad.push(op);
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
