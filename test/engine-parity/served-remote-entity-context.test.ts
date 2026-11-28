/**
 * BrainEngine parity: the reads a remote entity card, context_pack and volunteer_context make for the pages that refer to
 * an entity, called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded, multi-user or served) a remote
 *    caller's entity card and context_pack list the pages that refer to an entity, the records among them
 *    (entity.record_types) and the pages that name it only in text, and volunteer_context resolves a name and reports its
 *    own usage, through these typed members: readReflexPages (volunteer_context), readReferrerGroupRows, readReferrerRecordCandidates, readReferrerRecordPages,
 *    readTextMentionPages (the entity card), readTrustGeneration (context_pack), readReflexLiveKeys and readVolunteerUsage
 *    (volunteer_context and its stats). The seed holds a private page and a readers-only page with their own markers that
 *    refer to the entity as a record, a link and a text mention; no answer to the remote caller carries a marker.
 *  - Regression: a served client of a brain server refused one of these members with a typed refusal while the remote
 *    operation that reaches it was served, so the card, the pack or the volunteer answer stopped; a member that answered a
 *    hidden referrer would show the marker here.
 *  - Why existing coverage misses it: the member parity files call each member directly, never through the remote
 *    operation, and the served set had no case that asks for a card, a pack or a volunteer answer.
 *  - Seam: none. Pages are seeded with putPage, sealChunks, setPageAliases and addLink; the operations run as production code.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { remoteView, seedEntityBrain } from '../helpers/served-remote-brain.ts';

const { parityTest } = parityArms(testBackends());
parityTest('a remote entity card lists the referring records and the text mentions of an entity, never a hidden page', {
  methods: ['putPage', 'sealChunks', 'setPageAliases', 'addLink', 'setConfig', 'readReferrerGroupRows', 'readReferrerRecordCandidates', 'readReferrerRecordPages', 'readTextMentionPages'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const answer = {
    person: await remoteView(engine, 'entity', { name: 'Jane Doe' }),
    company: await remoteView(engine, 'entity', { name: 'Acme' }),
    unlinkedName: await remoteView(engine, 'entity', { name: 'Zed X' }),
  };
  for (const view of Object.values(answer)) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  // The open meeting is a record of the person; the private one is not shown.
  expect(answer.person.slugs).toContain('meetings/2026-01-01-acme');
  expect(answer.person.slugs).not.toContain('meetings/2026-01-02-zqprivmark');
  expect(answer.unlinkedName.slugs).toContain('notes/zed-open-note');
  return answer;
});

parityTest('a remote context_pack and volunteer_context resolve a name, read the trust generation and the live keys of its alias, and count usage', {
  methods: ['putPage', 'sealChunks', 'setPageAliases', 'addLink', 'setConfig', 'readTrustGeneration', 'readReflexPages', 'readReflexLiveKeys', 'readVolunteerUsage'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await seedEntityBrain(engine);
  const answer = {
    pack: await remoteView(engine, 'context_pack', { entities: 'Jane Doe' }),
    // min_confidence 1 gates every page out after the reads, so the op logs no volunteer event: that telemetry write
    // (insertVolunteerEvents) is not served, and a remote volunteer_context that returns a page drops it silently.
    volunteerByAlias: await remoteView(engine, 'volunteer_context', { window: 'user: tell me about Acme Corp', min_confidence: 1 }),
    volunteerStats: await remoteView(engine, 'volunteer_context', { stats: true }),
  };
  for (const view of Object.values(answer)) {
    expect(view.isError).toBe(false);
    expect(view.leaked).toEqual([]);
  }
  expect(answer.volunteerByAlias.slugs).toEqual([]);
  return answer;
});
