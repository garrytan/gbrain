/**
 * BrainEngine parity — a remote member's fact reads when a folder rule names it: an ordinary member that satisfies a rule, a
 * member that does not, and a labelled-only member that satisfies it, through the real MCP dispatch (the stdio member path).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a fact whose entity page sits under a folder rule is shown only to a caller that satisfies the rule (a held fact,
 *    one the page-less holding page stores: sharedHeldRuledSql), and every other fact obeys its provenance page and its entity
 *    page, for the caller's own identity only on its own member page. A labelled-only member (carol-example) reads facts only
 *    on its own member page (labelledOnlyFactSql), whatever folder rule it satisfies. What a caller may not read is absent from
 *    every list and its page comes back page_not_found, the same on PGLite, Postgres and Rust.
 *  - Regression: the Rust store never served a fact read for a caller that satisfies a folder rule, and refused every
 *    labelled-only fact read, and every fact read with access.members_read_lineage on, with engine_capability_missing. Each case returns a refusal as a value ({ refused }), so a Rust
 *    arm that refuses fails the comparison with PGLite instead of counting as stopped.
 *  - Why existing coverage misses it: no parity case read facts as a member that meets a folder rule, or as a labelled-only member.
 *  - Seam: members through createMember and the typed labelled-only write; folder rules through restrictFolder; the read is
 *    the real dispatchToolCall with a stdio member.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createMember, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const CAROL = 'carol-example';
const DANA = 'dana-example';
const BOB = 'bob-example';
const HOLDING = 'memory/unattributed';
const CAROL_PAGE = `memory/members/${CAROL}`;
const DANA_PAGE = `memory/members/${DANA}`;

/** A fact: where its text is stored (the provenance page) and what it is about (the entity page). */
interface Seed { id: string; text: string; provenance: string; entity: string | null; visibility?: 'private' }
const FACTS: readonly Seed[] = [
  { id: 'held-carol-rule', text: 'zzfact held under the rule that lists carol and dana', provenance: HOLDING, entity: 'ruled-carol/acme' },
  { id: 'held-bob-rule', text: 'zzfact held under the rule that lists bob', provenance: HOLDING, entity: 'ruled-bob/corp' },
  { id: 'held-open', text: 'zzfact held on an open page', provenance: HOLDING, entity: 'open/thing' },
  { id: 'own-page', text: 'zzfact on the member page of carol', provenance: CAROL_PAGE, entity: null },
  { id: 'open-page', text: 'zzfact on an open page', provenance: 'open/plain', entity: 'open/plain' },
  // A private fact on the member's own member page widens the list for that member (memberFactAdmitSql), and that page sits under a rule it satisfies.
  { id: 'own-private-carol', text: 'zzfact private on the member page of carol', provenance: CAROL_PAGE, entity: null, visibility: 'private' },
  { id: 'own-private-dana', text: 'zzfact private on the member page of dana', provenance: DANA_PAGE, entity: null, visibility: 'private' },
  { id: 'entity-ruled-carol', text: 'zzfact kept on an open page about a company under the rule that lists carol and dana', provenance: 'open/plain', entity: 'ruled-carol/acme' },
  { id: 'entity-ruled-bob', text: 'zzfact kept on an open page about a company under the rule that lists bob', provenance: 'open/plain', entity: 'ruled-bob/corp' },
  { id: 'readers-page', text: 'zzfact on a page that names carol', provenance: 'open/readers-carol', entity: 'open/readers-carol' },
];
/** The facts each member reads, by the SQL rules (a fact absent here is hidden from that member). */
const WANT: Record<string, string[]> = {
  [DANA]: ['held-carol-rule', 'held-open', 'open-page', 'entity-ruled-carol', 'own-private-dana'],
  [BOB]: ['held-bob-rule', 'held-open', 'open-page', 'entity-ruled-bob'],
  [CAROL]: ['own-page', 'own-private-carol'],
};
/** With access.members_read_lineage on the provenance page is judged by the member's own identity, so carol also reads the fact on the page that names her. */
const LINEAGE_WANT: Record<string, string[]> = { ...WANT, [CAROL]: ['own-page', 'own-private-carol', 'readers-page'] };
const PAGES = ['ruled-carol/acme', 'ruled-bob/corp', 'open/thing', 'open/plain', 'open/readers-carol', CAROL_PAGE, DANA_PAGE];

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com' });
  await createMember(engine, backend, { id: BOB });
  await createMember(engine, backend, { id: CAROL, groups: ['team-a'] });
  await createMember(engine, backend, { id: DANA, groups: ['team-a'] });
  await setOwner(engine, 'alice-example');
  await setMemberLabelledOnly(engine, CAROL, true, { remote: false });
  await restrictFolder(engine, backend, 'default', 'ruled-carol/', 'rule', { ruleId: 'rule-carol', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  await restrictFolder(engine, backend, 'default', 'ruled-bob/', 'rule', { ruleId: 'rule-bob', readers: ['member:alice-example', `member:${BOB}`] });
  // The member pages sit under a rule that lists carol, dana and alice (not bob): each member satisfies it for its own page.
  await restrictFolder(engine, backend, 'default', 'memory/members/', 'rule', { ruleId: 'rule-members', readers: ['member:alice-example', `member:${CAROL}`, `member:${DANA}`] });
  const page = (slug: string, frontmatter: Record<string, unknown> = {}) =>
    engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `page ${slug}`, timeline: '', frontmatter }, { sourceId: 'default' });
  await page(HOLDING);
  for (const slug of ['ruled-carol/acme', 'ruled-bob/corp', 'open/thing', 'open/plain']) await page(slug);
  await page('open/readers-carol', { readable_by: [CAROL] });
  await page(CAROL_PAGE, { readable_by: [`member:${CAROL}`] });
  await page(DANA_PAGE, { readable_by: [`member:${DANA}`] });
  const rows = FACTS.map((f, i) => ({ fact: f.text, kind: 'fact', visibility: f.visibility ?? 'world', source: 'test', entity_slug: f.entity ?? undefined, source_markdown_slug: f.provenance, row_num: i + 1 }));
  for (const row of rows) await engine.insertFacts([row] as never, { source_id: 'default' });
}

async function remote(engine: BrainEngine, member: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const out = await dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: member } as never)
    .catch((e: { code?: string }) => ({ thrown: String(e.code) }));
  if ('thrown' in out) return { refused: out.thrown };
  const text = out.content.map(part => (part as { text?: string }).text ?? '').join('');
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* plain text */ }
  if (!out.isError) return body;
  const code = (body as { code?: string } | null)?.code;
  if (code === 'engine_capability_missing') return { refused: code };
  if (/page_not_found/.test(text)) return 'not_found';
  return { error: code ?? text.slice(0, 200) };
}

/** The seeded fact ids a recall answered, by the marker word the fact text starts with. */
function factIds(answer: unknown): string[] | { refused: string } | { error: unknown } {
  if (answer && typeof answer === 'object' && ('refused' in answer || 'error' in answer)) return answer as { refused: string };
  const facts = ((answer as { facts?: Array<{ fact?: string }> } | null)?.facts ?? []).map(f => String(f.fact));
  // A remote read wraps a fact's text as a quoted excerpt, so each seeded fact is found by its text inside it.
  return FACTS.filter(f => facts.some(text => text.includes(f.text))).map(f => f.id).sort();
}

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-facts-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe('engine parity: remote fact reads of a member under a folder rule', () => {
  for (const member of [DANA, BOB, CAROL]) {
    parityTest(`${member}: recall, and the pages behind each fact, answer the same on every engine`, {
      methods: ['putPage', 'insertFacts', 'listFactsSince', 'listFactsByEntity'], timeout: 240_000,
    }, (engine, backend) => inFreshHome(async () => {
      await seed(engine, backend);
      const recent = await remote(engine, member, 'recall', {});
      const since = factIds(await remote(engine, member, 'recall', { since: '2000-01-01T00:00:00Z', include_undated: true }));
      const byEntity: Record<string, unknown> = {};
      for (const f of FACTS) if (f.entity) byEntity[f.entity] = factIds(await remote(engine, member, 'recall', { entity: f.entity }));
      const pages: Record<string, unknown> = {};
      for (const slug of PAGES) {
        const got = await remote(engine, member, 'get_page', { slug });
        pages[slug] = got === 'not_found' ? got : (got && typeof got === 'object' && 'refused' in got ? got : 'visible');
      }
      const ids = factIds(recent);
      expect(ids).toEqual([...WANT[member]!].sort());
      for (const f of FACTS) if (f.entity) expect({ entity: f.entity, ids: byEntity[f.entity] }).toEqual({ entity: f.entity, ids: FACTS.filter(g => g.entity === f.entity && WANT[member]!.includes(g.id)).map(g => g.id).sort() });
      expect(since).toEqual(ids);
      return { ids, since, byEntity, pages };
    }));
  }
});

describe('engine parity: fact reads with access.members_read_lineage on (RUST_ENGINE.md, row 32e-b-4)', () => {
  // The fact list read of a member with lineage on is answered by every engine: the fact policy judges each provenance page by the
  // member's lineage (test/engine-parity/lineage-fact-reads.test.ts has the 12 families and the pending-prefix and hidden-page cases).
  // Without lineage the same read is served and equal (the cases above).
  parityTest('with access.members_read_lineage on, a labelled-only and an ordinary member read their facts on every engine', {
    methods: ['putPage', 'insertFacts', 'listFactsSince'], timeout: 240_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seed(engine, backend);
    await setMembersReadLineage(engine, true, { remote: false });
    const answers: Record<string, string[]> = {};
    for (const member of [CAROL, DANA]) {
      const record = await remoteCallerAccess(engine, undefined, [], 'stdio', null, member, true);
      expect(record.lineage).toBe(true);
      const rows = await withCallerAccess({ ...record }, () => engine.listFactsSince('default', new Date(0), { excludePrivate: true, visibility: ['world'], limit: 50 } as never));
      answers[member] = FACTS.filter(f => rows.some(r => String(r.fact).includes(f.text))).map(f => f.id).sort();
    }
    expect(answers).toEqual({ [CAROL]: [...LINEAGE_WANT[CAROL]!].sort(), [DANA]: [...LINEAGE_WANT[DANA]!].sort() });
    return answers;
  }));

  // Recall answers on every engine with lineage on, for a labelled-only and an ordinary member.
  parityTest('with access.members_read_lineage on, recall answers the same facts on every engine, for a labelled-only and an ordinary member', {
    methods: ['putPage', 'insertFacts', 'listFactsSince'], timeout: 240_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seed(engine, backend);
    await setMembersReadLineage(engine, true, { remote: false });
    const answers: Record<string, unknown> = {};
    for (const member of [CAROL, DANA]) {
      const ids = factIds(await remote(engine, member, 'recall', {}));
      expect({ member, ids }).toEqual({ member, ids: [...LINEAGE_WANT[member]!].sort() });
      answers[member] = ids;
    }
    return answers;
  }));
});
