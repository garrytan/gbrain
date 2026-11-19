/**
 * BrainEngine parity — the four fact list reads under `excludePrivate` for a remote caller on a brain that never named
 * readers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a caller record with `restricted: false` (no page names readers and no member exists, so
 *    `access.restrictions_present` is unset) renders the short member-access form of the fact policy. Under it,
 *    listFactsByEntity, listFactsSince, listFactsKeyset and listFactsBySession in the hot-memory call shape
 *    (facts/meta-hook.ts) show a fact whose entity page is private to a caller with a private-readable grant on that
 *    page's source, hide it from a plain caller and a caller granted another source, and hide a fact
 *    whose provenance page is private from every one of them. The four reads agree with each other on every engine arm.
 *    A member caller reads as a plain one, a fact from its own private member page included, with no visibility list
 *    and in the hot-memory shape: the short form reads no identity, and no page names readers, so neither the provenance
 *    gate nor the visibility list's member-page rule (memberFactAdmitSql) admits that fact.
 *  - Regression: the Rust arm compared the short form with the full no-caller text, found them different and refused
 *    every one of these reads, so hot memory (meta-hook.ts) got a typed refusal for every stdio MCP caller on a Rust
 *    brain.
 *  - Why existing coverage misses it: the fact list cases in facts-reads and trust-reads read as the default record
 *    (`restricted` true); unrestricted-caller reads cover listUnattributedFacts only.
 *  - Seam: none. Real engines, typed methods only; the fixture writes no `readable_by` page, as the premise of the
 *    short form requires.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { MEMBER_PAGE_PREFIX } from '../../src/core/access/principals.ts';

const { parityTest } = parityArms(testBackends());

const ENTITY = 'people/a-example';
const PRIVATE_ENTITY = 'people/b-example';
const SESSION = 'session-unrestricted';
const MEMBER = { restricted: false, identity: ['member:alice-example'], hidePrivate: true } as const;

/** Two open pages, two private pages and two private member pages, with one world fact on each kind, and one private fact on the member's own page. */
async function fixture(engine: BrainEngine) {
  await engine.putPage(ENTITY, { type: 'person', title: 'A', compiled_truth: 'A', timeline: '' });
  await engine.putPage(PRIVATE_ENTITY, { type: 'person', title: 'B', compiled_truth: 'B', timeline: '', frontmatter: { visibility: 'private' } });
  await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'open', timeline: '' });
  await engine.putPage('notes/private', { type: 'note', title: 'Private', compiled_truth: 'private', timeline: '', frontmatter: { visibility: 'private' } });
  for (const member of ['alice-example', 'bob-example']) {
    await engine.putPage(`${MEMBER_PAGE_PREFIX}${member}`, { type: 'note', title: member, compiled_truth: member, timeline: '', frontmatter: { visibility: 'private' } });
  }
  const rows = [
    { fact: 'open fact', entity_slug: ENTITY, source_markdown_slug: 'notes/open' },
    { fact: 'private provenance fact', entity_slug: ENTITY, source_markdown_slug: 'notes/private' },
    { fact: 'private entity fact', entity_slug: PRIVATE_ENTITY, source_markdown_slug: 'notes/open' },
    { fact: 'own member page fact', entity_slug: ENTITY, source_markdown_slug: `${MEMBER_PAGE_PREFIX}alice-example` },
    { fact: 'other member page fact', entity_slug: ENTITY, source_markdown_slug: `${MEMBER_PAGE_PREFIX}bob-example` },
    { fact: 'own private member fact', entity_slug: ENTITY, source_markdown_slug: `${MEMBER_PAGE_PREFIX}alice-example`, visibility: 'private' },
  ];
  await engine.insertFacts(rows.map((r, i) => ({
    visibility: 'world', ...r, row_num: i + 1, kind: 'fact', source: 'fence', source_session: SESSION,
    valid_from: new Date(Date.UTC(2026, 4, 1 + i)),
  })) as never, { source_id: 'default' });
}

/** The unrestricted callers: plain, a grant on `default`, and a grant on `other` only. */
const CALLERS = {
  plain: { restricted: false, hidePrivate: true },
  granted: { restricted: false, privateReadableSources: ['default'], hidePrivate: true },
  grantedOther: { restricted: false, privateReadableSources: ['other'], hidePrivate: true },
} as const;

describe('engine parity: the fact list reads for a remote caller on a brain that never named readers', () => {
  parityTest(
    'the four fact list reads show a private entity fact only to a caller granted its source and hide private provenance from all',
    { methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'other');
      await fixture(engine);
      // The hot-memory call shape (facts/meta-hook.ts): active rows, world visibility, fingerprints, excludePrivate.
      const shape = { activeOnly: true, limit: 30, visibility: ['world' as const], fingerprint: true, excludePrivate: true };
      const reads: Record<string, () => Promise<Array<{ fact: string }>>> = {
        byEntity: async () => [
          ...await engine.listFactsByEntity('default', ENTITY, shape),
          ...await engine.listFactsByEntity('default', PRIVATE_ENTITY, shape),
        ],
        since: () => engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), shape),
        keyset: () => engine.listFactsKeyset('default', null, shape),
        bySession: () => engine.listFactsBySession('default', SESSION, shape),
      };
      const out: Record<string, Record<string, string[]>> = {};
      for (const [read, run] of Object.entries(reads)) {
        const byCaller: Record<string, string[]> = {};
        for (const [name, caller] of Object.entries(CALLERS)) {
          byCaller[name] = await withCallerAccess(caller, async () => sorted((await run()).map(r => r.fact)));
        }
        out[read] = byCaller;
      }
      const shown = out.since!;
      expect(shown.plain).toContain('open fact');
      expect(shown.plain).not.toContain('private entity fact');
      expect(shown.granted).toContain('private entity fact');
      expect(shown.grantedOther).not.toContain('private entity fact');
      for (const name of Object.keys(CALLERS)) expect(shown[name]).not.toContain('private provenance fact');
      expect(shown.plain).toEqual(['open fact']);
      expect(shown.granted).toEqual(['open fact', 'private entity fact']);
      expect(shown.grantedOther).toEqual(shown.plain);
      for (const read of ['byEntity', 'keyset', 'bySession']) expect(out[read]).toEqual(out.since!);
      return out;
    },
  );


  parityTest(
    'a member caller reads the four fact list reads as a plain caller does, with and without a visibility list',
    { methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset', 'listFactsBySession'] },
    async (engine: BrainEngine) => {
      await fixture(engine);
      const shapes = {
        plainShape: { activeOnly: true, limit: 30, excludePrivate: true },
        hotMemory: { activeOnly: true, limit: 30, visibility: ['world' as const], fingerprint: true, excludePrivate: true },
        worldOnly: { activeOnly: true, limit: 30, visibility: ['world' as const] },
      };
      const read = async (shape: (typeof shapes)[keyof typeof shapes]) => ({
        byEntity: sorted([...await engine.listFactsByEntity('default', ENTITY, shape), ...await engine.listFactsByEntity('default', PRIVATE_ENTITY, shape)].map(r => r.fact)),
        since: sorted((await engine.listFactsSince('default', new Date(Date.UTC(2000, 0, 1)), shape)).map(r => r.fact)),
        keyset: sorted((await engine.listFactsKeyset('default', null, shape)).map(r => r.fact)),
        bySession: sorted((await engine.listFactsBySession('default', SESSION, shape)).map(r => r.fact)),
      });
      const out: Record<string, { plain: unknown; member: unknown }> = {};
      for (const [name, shape] of Object.entries(shapes)) {
        const plain = await withCallerAccess(CALLERS.plain, () => read(shape));
        const member = await withCallerAccess(MEMBER, () => read(shape));
        expect(member).toEqual(plain);
        for (const facts of Object.values(member)) expect(facts).not.toContain('own private member fact');
        out[name] = { plain, member };
      }
      // The short form reads no identity: the member's own private member page stays hidden, as every other private page.
      expect((out.plainShape!.plain as { since: string[] }).since).toEqual(['open fact']);
      expect((out.hotMemory!.plain as { since: string[] }).since).toEqual(['open fact']);
      return out;
    },
  );
});
