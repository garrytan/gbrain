/**
 * BrainEngine parity — the reads an MCP write's `_meta` hook runs after a remember (facts/meta-hook.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: activationVerdicts (eligibility/activation.ts), factsFromQuotedPages and quoteFacts
 *    (search/transcript-quote.ts) return the same tier, suppression and quote answer for the same rows on every engine
 *    arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that answers these differently changes which facts the hot-memory channel injects, which it
 *    labels unconfirmed, and which it fences as quoted third-party text. On the Rust engine the reads ran through
 *    `executeRaw`, so an MCP remember committed its fact and then failed in the hook.
 *  - Why existing coverage misses it: the statements ran through `executeRaw`, which the parity cases cannot call (D18).
 *  - Seam: none. Rows are seeded through `putPage`, `insertFact` and `insertFacts`, the tiers through the write trust
 *    context (`applyTransactionSettings` inside `transaction`). No typed write records a write-gate receipt or a
 *    derivation input, so the flagged and derivation arms are compared only in their empty answer.
 *    Fact and page ids differ between arms: rows are named by text or slug.
 *  - The hook's own fact read (listFactsSince with excludePrivate) runs under the MCP caller's record, which carries
 *    the schema version its request read; the Rust policy match rendered its reference text without that version, so
 *    the read refused ("excludePrivate for a caller whose member pages, grants or lineage widen the policy").
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { activationVerdicts } from '../../src/core/eligibility/activation.ts';
import { factsFromQuotedPages, quoteFacts } from '../../src/core/search/transcript-quote.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const day = (n: number) => new Date(Date.UTC(2026, 4, n));

/** Run `fn` in a transaction whose write trust context declares `tier`. */
function declared<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

describe('engine parity: the remember _meta hook reads', () => {
  parityTest('activationVerdicts reads each fact and page row\'s stored tier, answers no flag, and omits a missing id', {
    methods: ['transaction', 'applyTransactionSettings', 'insertFact', 'putPage', 'softDeletePage', 'readRowTrustRows', 'readPageTrustRows'],
  }, async (engine) => {
    const owner = await declared(engine, 'operator_curated', tx =>
      tx.insertFact({ fact: 'Owner fact', source: 'mcp:remember', entity_slug: 'people/alice', valid_from: day(1) }, { source_id: SRC }));
    const agent = await declared(engine, 'agent_written', tx =>
      tx.insertFact({ fact: 'Agent fact', source: 'mcp:remember', entity_slug: 'people/alice', valid_from: day(2) }, { source_id: SRC }));
    const plain = await engine.insertFact({ fact: 'Plain fact', source: 'mcp:remember', entity_slug: null, valid_from: day(3) }, { source_id: SRC });
    const curated = await declared(engine, 'operator_curated', tx =>
      tx.putPage('notes/curated', { type: 'note', title: 'Curated', compiled_truth: 'x' }));
    const gone = await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'x' });
    await engine.softDeletePage('notes/gone');
    const name = new Map<string, string>([
      [`facts:${owner.id}`, 'owner'], [`facts:${agent.id}`, 'agent'], [`facts:${plain.id}`, 'plain'],
      [`pages:${curated.id}`, 'curated'], [`pages:${gone.id}`, 'gone'],
    ]);
    const refs = [
      { table: 'facts' as const, id: owner.id }, { table: 'facts' as const, id: agent.id }, { table: 'facts' as const, id: plain.id },
      { table: 'facts' as const, id: 9_999_999 }, { table: 'pages' as const, id: curated.id }, { table: 'pages' as const, id: gone.id },
    ];
    const read = async (policy: Parameters<typeof activationVerdicts>[2]) => Object.fromEntries(
      [...(await activationVerdicts(engine, refs, policy))].map(([key, v]) => [name.get(key) ?? `other:${key}`, v]));
    const open = await read({});
    const floored = await read({ floor: 'operator_curated', suppressFlagged: true });
    expect(open).toEqual({
      owner: { tier: 'operator_curated', belowFloor: false, suppressed: false, unconfirmed: false },
      agent: { tier: 'agent_written', belowFloor: false, suppressed: false, unconfirmed: false },
      plain: { tier: 'unknown', belowFloor: false, suppressed: false, unconfirmed: false },
      curated: { tier: 'operator_curated', belowFloor: false, suppressed: false, unconfirmed: false },
      gone: { tier: 'unknown', belowFloor: false, suppressed: false, unconfirmed: false },
    });
    expect(Object.fromEntries(Object.entries(floored).map(([k, v]) => [k, v.belowFloor]))).toEqual({
      owner: false, agent: true, plain: true, curated: false, gone: true,
    });
    return { open, floored };
  });

  parityTest('factsFromQuotedPages names the facts held on a chat page or saved by a backstop that names one; quoteFacts fences them and, for an untrusted reader, every fact below the owner tier', {
    methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'listFactsFromQuotedPages', 'listOwnerTierFacts'],
  }, async (engine) => {
    await engine.putPage('chats/session-a', { type: 'chat', title: 'Session A', compiled_truth: 'x' });
    await engine.putPage('notes/plain', { type: 'note', title: 'Plain', compiled_truth: 'x' });
    const onChat = await engine.insertFacts([{ row_num: 1, source_markdown_slug: 'chats/session-a', fact: 'Fence row on a chat page',
      source: 'fence', entity_slug: 'people/alice', visibility: 'world', valid_from: day(1) }], { source_id: SRC });
    const onNote = await engine.insertFacts([{ row_num: 1, source_markdown_slug: 'notes/plain', fact: 'Fence row on a note',
      source: 'fence', entity_slug: 'people/alice', visibility: 'world', valid_from: day(2) }], { source_id: SRC });
    const backstop = await engine.insertFact({ fact: 'Backstop from a chat page', source: 'mcp:put_page', source_session: 'put_page:chats/session-a',
      entity_slug: 'people/alice', valid_from: day(3) }, { source_id: SRC });
    const backstopNote = await engine.insertFact({ fact: 'Backstop from a note', source: 'sync:import', source_session: 'sync:notes/plain',
      entity_slug: 'people/alice', valid_from: day(4) }, { source_id: SRC });
    const owner = await declared(engine, 'operator_curated', tx =>
      tx.insertFact({ fact: 'Owner remembered', source: 'mcp:remember', entity_slug: 'people/alice', valid_from: day(5) }, { source_id: SRC }));
    const agent = await declared(engine, 'agent_written', tx =>
      tx.insertFact({ fact: 'Agent remembered', source: 'mcp:remember', entity_slug: 'people/alice', valid_from: day(6) }, { source_id: SRC }));
    const facts = [
      { id: onChat.ids[0]!, fact: 'Fence row on a chat page' }, { id: onNote.ids[0]!, fact: 'Fence row on a note' },
      { id: backstop.id, fact: 'Backstop from a chat page' }, { id: backstopNote.id, fact: 'Backstop from a note' },
      { id: owner.id, fact: 'Owner remembered' }, { id: agent.id, fact: 'Agent remembered' },
    ];
    const label = new Map(facts.map(f => [Number(f.id), f.fact]));
    const fromPages = [...await factsFromQuotedPages(engine, [...facts.map(f => f.id), 9_999_999])].map(id => label.get(id) ?? `other:${id}`).sort();
    expect(fromPages).toEqual(['Backstop from a chat page', 'Fence row on a chat page']);
    const quoted = async (untrusted: boolean) => (await quoteFacts(engine, facts, untrusted)).filter(f => f.quoted).map(f => label.get(Number(f.id))).sort();
    const trusted = await quoted(false);
    const untrusted = await quoted(true);
    expect(trusted).toEqual(fromPages);
    expect(untrusted).toEqual(['Agent remembered', 'Backstop from a chat page', 'Backstop from a note', 'Fence row on a chat page', 'Fence row on a note']);
    // The members themselves, with arguments the wrappers never pass: another page type and backstop pair, and two floors.
    const names = (ids: number[]) => ids.map(id => label.get(Number(id)) ?? `other:${id}`).sort();
    const ids = facts.map(f => f.id);
    const members = {
      notePages: names(await engine.listFactsFromQuotedPages({ ids, pageTypes: ['note'], backstop: [['sync:import', 'sync:'], ['mcp:put_page', 'put_page:']] })),
      noBackstop: names(await engine.listFactsFromQuotedPages({ ids, pageTypes: ['chat'], backstop: [['none', 'none:'], ['none', 'none:']] })),
      noIds: await engine.listFactsFromQuotedPages({ ids: [], pageTypes: ['chat'], backstop: [['sync:import', 'sync:'], ['mcp:put_page', 'put_page:']] }),
      operator: names(await engine.listOwnerTierFacts({ ids: [...ids, 9_999_999], floor: 'operator_curated' })),
      agent: names(await engine.listOwnerTierFacts({ ids, floor: 'agent_written' })),
    };
    expect(members).toEqual({
      notePages: ['Backstop from a note', 'Fence row on a note'], noBackstop: ['Fence row on a chat page'], noIds: [],
      operator: ['Owner remembered'], agent: ['Agent remembered', 'Owner remembered'],
    });
    return { fromPages, trusted, untrusted, members };
  });

  parityTest('listFactsSince and listFactsBySession hide a fact held on a private page from a remote caller whose record carries the schema version its request read', {
    methods: ['putPage', 'insertFacts', 'listFactsSince', 'listFactsBySession'],
  }, async (engine) => {
    const REMOTE_POLICY = { privacyRelaxed: false, restricted: false, ownerMember: null, ownerReadsRestricted: false, membersReadLineage: false, schemaVersion: LATEST_SCHEMA_VERSION };
    const REMOTE = { identity: [], hidePrivate: true, restricted: false, remotePolicy: REMOTE_POLICY };
    await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'x' });
    await engine.putPage('notes/private', { type: 'note', title: 'Private', compiled_truth: 'x', frontmatter: { visibility: 'private' } });
    for (const [fact, slug] of [['Open fact', 'notes/open'], ['Private fact', 'notes/private']] as const) {
      await engine.insertFacts([{ row_num: 1, source_markdown_slug: slug, fact, source: 'fence', source_session: 'session-a',
        entity_slug: 'people/alice', visibility: 'world', valid_from: day(1) }], { source_id: SRC });
    }
    const opts = { activeOnly: true, limit: 10, excludePrivate: true, fingerprint: true };
    const since = await withCallerAccess(REMOTE, () => engine.listFactsSince(SRC, new Date(0), opts));
    const session = await withCallerAccess(REMOTE, () => engine.listFactsBySession(SRC, 'session-a', opts));
    const out = { since: since.map(f => f.fact).sort(), session: session.map(f => f.fact).sort() };
    expect(out).toEqual({ since: ['Open fact'], session: ['Open fact'] });
    return out;
  });
});
