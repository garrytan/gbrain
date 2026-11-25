/**
 * BrainEngine parity — two reads that a Rust brain refused and a catch turned into a quiet default (lane 8's
 * refusal-swallow triage, docs/research/rust-refusal-swallow-triage.tsv on rust-engine/refusal-swallow-triage
 * 90ca2ca775, the lane 4 swap blockers): the brain-audience heuristic's credential binding read and the facts arm's
 * fact source page read.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: classifyBrainAudience (facts/writeback-audience.ts) counts people, not credentials, on every engine: three
 *    active clients bound to one member read as one person (personal), and bound to two members as shared.
 *    applyFactSourcePages (search/facts-arm.ts) puts a matched fact's source conversation into the results on every
 *    engine, and never the fact's own entity page.
 *  - Regression: both reads ran through `executeRaw`, which the Rust engine refuses, and a catch turned the refusal into
 *    a default: the binding read into "no bindings" (every client its own person: a one-person brain read as shared),
 *    and the source page read into "the results unchanged" (no source conversation). Both now read typed members
 *    (listCredentialMemberBindings, listFactSourcePages), and a capability refusal from either path reaches the caller.
 *  - Why existing coverage misses it: test/brain-audience-people.test.ts and test/search-8k-conversion.test.ts run on
 *    PGLite only.
 *  - Seam: none. Members, tokens, OAuth clients and request-log rows come from typed members (addMember,
 *    mintLegacyToken, insertOauthClient, bindCredential, logMcpRequest); pages from the import path; facts from insertFacts.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { classifyBrainAudience, BRAIN_AUDIENCE_KEY } from '../../src/core/facts/writeback-audience.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { applyFactSourcePages } from '../../src/core/search/facts-arm.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** One active MCP client: a legacy token or an OAuth client named `name`, bound to `member` (or nobody), with five calls in the log. */
async function client(engine: BrainEngine, name: string, member: string | null, kind: 'token' | 'client' = 'token'): Promise<void> {
  if (kind === 'token') {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
    if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  } else {
    await engine.insertOauthClient({ client_id: name, client_name: name, redirect_uris: [], grant_types: ['client_credentials'], scope: 'read' });
    if (member) await bindCredential(engine, { kind: 'client', id: name }, { member });
  }
  for (let i = 0; i < 5; i++) await engine.logMcpRequest({ token_name: name, agent_name: null, operation: 'search', latency_ms: 5, status: 'success' });
}

describe('engine parity: the lane 4 refusal-swallow reads', () => {
  parityTest('the brain audience counts the clients bound to one member as one person, and two members as shared', {
    methods: ['getConfig', 'readClientOpUsage', 'listCredentialMemberBindings', 'insertAccessToken', 'insertOauthClient', 'logMcpRequest'],
  }, async (engine) => {
    await engine.unsetConfig(BRAIN_AUDIENCE_KEY);
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await client(engine, 'alice-laptop', 'alice-example');
    await client(engine, 'alice-phone', 'alice-example');
    await client(engine, 'alice-agent', 'alice-example', 'client');
    const onePerson = await classifyBrainAudience(engine);
    await client(engine, 'bob-laptop', 'bob-example');
    const twoPeople = await classifyBrainAudience(engine);
    const bindings = (await engine.listCredentialMemberBindings(['alice-laptop', 'alice-agent', 'bob-laptop', 'nobody']))
      .map(b => `${b.name}=${b.member_id}`).sort();
    const out = { onePerson: onePerson.audience, twoPeople: twoPeople.audience, bindings, none: await engine.listCredentialMemberBindings([]) };
    expect(out).toEqual({ onePerson: 'personal', twoPeople: 'shared',
      bindings: ['alice-agent=alice-example', 'alice-laptop=alice-example', 'bob-laptop=bob-example'], none: [] });
    return out;
  });

  parityTest('the facts arm adds a matched fact\'s source conversation, never the fact\'s own entity page or a note', {
    methods: ['putPage', 'insertFacts', 'listFactSourcePages', 'getChunkWindows', 'listFactsForRelevance'],
  }, async (engine) => {
    // The import path chunks each body, so getChunkWindows has a chunk to hand over.
    const page = (type: string, title: string, body: string, date: string) => `---\ntype: ${type}\ntitle: ${title}\ndate: ${date}\n---\n${body}\n`;
    await importFromContent(engine, 'notes/acme-example-notes', page('note', 'Acme example notes', 'Orchard rollout was approved in the notes.', '2025-05-02'), { noEmbed: true });
    await importFromContent(engine, 'conversations/orchard-self', page('conversation', 'Orchard self chat', '**User:** Orchard rollout.', '2025-05-03'), { noEmbed: true });
    await importFromContent(engine, 'conversations/orchard-call', page('conversation', 'Orchard call', '**User:** Orchard rollout call.', '2025-05-04'), { noEmbed: true });
    const fact = (text: string, entity: string, slug: string, row: number) => ({ fact: text, entity_slug: entity, kind: 'event', source: 'conversation',
      visibility: 'world', confidence: 1, valid_from: new Date('2025-06-02T00:00:00Z'), source_markdown_slug: slug, row_num: row });
    const { ids } = await engine.insertFacts([
      fact('The Orchard rollout was approved.', 'orchard', 'notes/acme-example-notes', 1),
      fact('The Orchard rollout date was confirmed.', 'conversations/orchard-self', 'conversations/orchard-self', 1),
      fact('The Orchard rollout kickoff was scheduled.', 'orchard', 'conversations/orchard-call', 1),
    ] as never, { source_id: 'default' });
    const sources = (await engine.listFactSourcePages([...ids.map(Number), 987_654_321])).map(r => r.slug).sort();
    const added = await applyFactSourcePages(engine, 'Orchard rollout approved confirmed kickoff scheduled', [],
      { sourceId: 'default', remote: false, readScope: { sourceId: 'default' }, rowCap: async () => 5 } as never);
    const out = { sources, added: added.map(r => r.slug), none: await engine.listFactSourcePages([]) };
    expect(out).toEqual({ sources: ['conversations/orchard-call', 'notes/acme-example-notes'], added: ['conversations/orchard-call'], none: [] });
    return out;
  });
});
