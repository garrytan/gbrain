/**
 * BrainEngine parity — the privacy probe for readPageAccessAllowed / readPageFolderRulesAllowed (engine-sql/list-reads.ts,
 * the Rust store-members/list-reads.ts) and `whoCanRead` (commands/access.ts), which is built on them: can a labelled-only
 * member be listed as a reader of, or read, a page that PGLite and Postgres hide from it?
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) a labelled-only member (carol-example) is listed by who-can-read for a page only when
 *    its own remote read (get_page and search through the stdio member path) shows that page, and every arm answers each
 *    page shape as PGLite does. Shapes: an open page; readable_by naming another member, the labelled-only member and
 *    its group; an open page under a folder rule that lists the labelled-only member, one that lists another member only,
 *    and one under two rules where it satisfies one; a derived page whose origin names it and one whose origin names
 *    another member; a malformed readable_by; a visibility: private page that names it.
 *  - Regression: the member-access predicate behind both reads (accessAllowedSql) has no labelled-only conjunct, which
 *    callerAccessSql ANDs on for a real read. If a page passes accessAllowed yet fails the labelled-only conjunct, the
 *    who-can-read list (and the notice a put prints from it) names a member that cannot read the page.
 *  - Why existing coverage misses it: test/access-labelled-only.test.ts runs whoCanRead on PGLite and Postgres only and
 *    compares it to no remote read; no parity case ran either read for a labelled-only caller.
 *  - Seam: members through `createMember` and the typed labelled-only write; folder rules through `restrictFolder`
 *    (harness-only SQL on the SQL arms, the store on Rust); the remote read is the real dispatchToolCall.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { createMember, parityArms, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { whoCanRead } from '../../src/commands/access.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setMembersReadLineage } from '../../src/core/access/lineage.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const CAROL = 'carol-example';
const WORD = 'zzprobeword';
const PRIVATE = 'open/private-carol';

interface Shape { slug: string; frontmatter: Record<string, unknown> }

/** The page shapes the probe reads, written after the folder rules so each page is stamped by the rules above it. */
const SHAPES: readonly Shape[] = [
  { slug: 'open/plain', frontmatter: {} },
  { slug: 'open/readers-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'open/readers-carol', frontmatter: { readable_by: ['carol-example'] } },
  { slug: 'open/readers-group', frontmatter: { readable_by: ['group:team-a'] } },
  { slug: 'ruled-carol/open', frontmatter: {} },
  { slug: 'ruled-bob/open', frontmatter: {} },
  { slug: 'two/sub/both-rules', frontmatter: {} },
  { slug: 'open/origin-carol', frontmatter: { readable_by: ['carol-example'] } },
  { slug: 'open/origin-bob', frontmatter: { readable_by: ['bob-example'] } },
  { slug: 'open/derived-carol', frontmatter: { derived_from: 'open/origin-carol.md' } },
  { slug: 'open/derived-bob', frontmatter: { derived_from: 'open/origin-bob.md' } },
  { slug: 'open/malformed', frontmatter: { readable_by: [42] } },
  { slug: 'open/private-carol', frontmatter: { visibility: 'private', readable_by: ['carol-example'] } },
];

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createMember(engine, backend, { id: 'alice-example', email: 'alice@example.com' });
  await createMember(engine, backend, { id: 'bob-example' });
  await createMember(engine, backend, { id: CAROL, groups: ['team-a'] });
  await setOwner(engine, 'alice-example');
  await setMemberLabelledOnly(engine, CAROL, true, { remote: false });
  await restrictFolder(engine, backend, 'default', 'ruled-carol/', 'rule', { ruleId: 'rule-carol', readers: ['member:alice-example', `member:${CAROL}`] });
  await restrictFolder(engine, backend, 'default', 'ruled-bob/', 'rule', { ruleId: 'rule-bob', readers: ['member:alice-example', 'member:bob-example'] });
  await restrictFolder(engine, backend, 'default', 'two/', 'rule', { ruleId: 'rule-two-carol', readers: ['member:alice-example', `member:${CAROL}`] });
  await restrictFolder(engine, backend, 'default', 'two/sub/', 'rule', { ruleId: 'rule-two-bob', readers: ['member:alice-example', 'member:bob-example'] });
  for (const s of SHAPES) {
    await engine.putPage(s.slug, { type: 'note', title: s.slug, compiled_truth: `${WORD} body of ${s.slug}`, timeline: '', frontmatter: s.frontmatter }, { sourceId: 'default' });
    // Keyword search reads sealed chunks, so give each page one.
    await installChunks(engine, s.slug, [chunk(0, `${WORD} body of ${s.slug}`)], { sourceId: 'default' });
  }
}

/** carol's remote read: get_page and search through the stdio member path (the real dispatch, remote: true). */
async function remoteRead(engine: BrainEngine, slug: string, withSearch: boolean): Promise<{ get: 'visible' | 'page_not_found'; search: boolean | null }> {
  const call = (tool: string, args: Record<string, unknown>) => dispatchToolCall(engine, tool, args, { remote: true, transport: 'stdio', sourceId: 'default', stdioMember: CAROL } as never);
  const text = (out: Awaited<ReturnType<typeof call>>) => out.content.map(part => (part as { text?: string }).text ?? '').join('');
  const refuse = (out: Awaited<ReturnType<typeof call>>) => {
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(text(out)) as Record<string, unknown>; } catch { /* plain text */ }
    // A capability refusal is rethrown as one, so the harness classifies it; nothing else is taken for hiding.
    if (body?.code === 'engine_capability_missing') throw Object.assign(new Error(String(body.message)), body);
  };
  const got = await call('get_page', { slug });
  if (got.isError) {
    refuse(got);
    if (!/page_not_found/.test(text(got))) throw new Error(`get_page ${slug}: ${text(got).slice(0, 300)}`);
  }
  // With lineage on, search also matches saved facts under the fact policy of a lineage read, which the Rust store refuses (row 32e-b-4,
  // pinned in labelled-only-reads.test.ts), so the search arm is read only with lineage off.
  if (!withSearch) return { get: got.isError ? 'page_not_found' : 'visible', search: null };
  const found = await call('search', { query: WORD, limit: 50 });
  if (found.isError) { refuse(found); throw new Error(`search ${slug}: ${text(found).slice(0, 300)}`); }
  return { get: got.isError ? 'page_not_found' : 'visible', search: text(found).includes(`"${slug}"`) };
}

/** The pages carol's remote read shows on the SQL engines, by access.members_read_lineage: the pages that name it, and under the lineage setting a derived page whose origin does. */
const VISIBLE = {
  off: ['open/readers-carol', 'open/readers-group', 'ruled-carol/open', 'open/origin-carol'],
  on: ['open/readers-carol', 'open/readers-group', 'ruled-carol/open', 'open/origin-carol', 'open/derived-carol'],
};

/** Run `fn` once with members-read-lineage off (the default), then on (a member reads a derived page whose origins it reads). */
async function eachLineage<T>(engine: BrainEngine, fn: (lineage: 'off' | 'on') => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  out.off = await fn('off');
  await setMembersReadLineage(engine, true, { remote: false });
  out.on = await fn('on');
  return out;
}

async function inFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-labelled-'));
  try { return await withEnv({ GBRAIN_HOME: home }, fn); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

describe('engine parity: a labelled-only member against who-can-read and the page access reads', () => {
  // (1) who-can-read and (3) the two access reads under carol's own caller record, on every arm. who-can-read must not list
  // carol for any page its remote read hides (VISIBLE is what the remote case below reads on the SQL engines), and every arm
  // answers as PGLite does.
  parityTest('who-can-read never lists a labelled-only member for a page its remote read hides, and the access reads agree on every engine', {
    methods: ['putPage', 'sealChunks', 'readWhoCanReadRows', 'readPageAccessAllowed', 'readPageFolderRulesAllowed'], timeout: 240_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seed(engine, backend);
    const table = await eachLineage(engine, async (lineage) => {
      const rows: Record<string, unknown> = {};
      const leaks: string[] = [];
      for (const s of SHAPES) {
        const [entry] = await whoCanRead(engine, s.slug, 'default');
        // carol's own caller record, as a remote read builds it (labelledOnly true).
        const record = await remoteCallerAccess(engine, undefined, [], 'stdio', null, CAROL);
        const identity = record.identity ?? [];
        const accessAllowed = await withCallerAccess({ ...record }, () => engine.readPageAccessAllowed('default', s.slug, identity));
        const folderRulesAllowed = await withCallerAccess({ ...record }, () => engine.readPageFolderRulesAllowed('default', s.slug, record.satisfiedRuleIds ?? []));
        const listed = Array.isArray(entry!.members) && entry!.members.includes(CAROL);
        rows[s.slug] = { members: entry!.members, listed, accessAllowed, folderRulesAllowed, labelledOnlyRecord: record.labelledOnly };
        if (s.slug === 'open/derived-carol') {
          // The note says what the labelled-only member reads: with lineage on a derived page is read when every origin names it
          // (it is not listed, the listing is a known gap on every engine); with lineage off it is read by nobody labelled.
          expect(lineage === 'on' ? /\(it is a derived page\) when every origin names them/.test(entry!.note) && !/so none of them reads it/.test(entry!.note)
            : /so none of them reads it/.test(entry!.note)).toBe(true);
        }
        if (s.slug === PRIVATE) {
          // A private page that names the member is listed with its own caveat (the note says the member still needs
          // private_pages: granted_sources), and its remote read is hidden on every engine: pinned, not counted as a leak.
          expect({ listed, note: /private_pages: granted_sources/.test(entry!.note) }).toEqual({ listed: true, note: true });
        } else if (listed && !VISIBLE[lineage].includes(s.slug)) leaks.push(s.slug);
      }
      expect(leaks).toEqual([]);
      return rows;
    });
    return table;
  }));

  // (2) carol's remote read (get_page, and search with lineage off, through the stdio member path), the same on every engine.
  parityTest('a labelled-only member reads over the remote path only the pages that name it, the same on every engine', {
    methods: ['putPage', 'sealChunks', 'readPageSnapshot'], timeout: 240_000,
  }, (engine, backend) => inFreshHome(async () => {
    await seed(engine, backend);
    const table = await eachLineage(engine, async (lineage) => {
      const reads: Record<string, unknown> = {};
      for (const s of SHAPES) reads[s.slug] = await remoteRead(engine, s.slug, lineage === 'off');
      const visible = SHAPES.filter(s => (reads[s.slug] as { get: string }).get === 'visible').map(s => s.slug);
      expect(visible).toEqual(SHAPES.map(s => s.slug).filter(slug => VISIBLE[lineage].includes(slug)));
      if (lineage === 'off') expect(SHAPES.filter(s => (reads[s.slug] as { search: boolean }).search).map(s => s.slug)).toEqual(visible);
      return reads;
    });
    return table;
  }));
});
