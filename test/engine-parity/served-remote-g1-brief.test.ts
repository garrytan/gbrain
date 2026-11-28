/**
 * BrainEngine parity: the reads behind a remote context_pack brief (a pull on a counterparty), over the served wire: the
 * counterparty's entity page (readBriefEntityPages), its edit page (readBriefEditPage), newest timeline entry
 * (readBriefTimelineEntry) and its revisions (readBriefPageVersions).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote context_pack (MCP stdio,
 *    dispatchToolCall with remote: true) with a counterparty briefs the same items: the newest timeline entry or the lines the newest
 *    revision added of a readable page, and nothing of a counterparty that is an owner-private page or a page only a named member
 *    may read (the brief answers as for an unresolved counterparty).
 *  - Regression: on the served arm each read was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so a remote
 *    context_pack with a counterparty failed with a typed engine_capability_missing refusal or lost its brief.
 *  - Why existing coverage misses it: brief-reads.test.ts and retrieval-reflex.test.ts call the brief on the arm's own engine; no
 *    parity file ran the remote operation that sends the reads over the served wire, and none held a hidden counterparty.
 *  - Seam: none. Pages, versions and timeline entries are written with typed members; the operation is the real one.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';

const { parityTest } = parityArms(testBackends());

const stdio = () => ({ remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', noticeLedger: new NoticeLedger() }) as never;
const SRC = 'default';
const page = (title: string, body = `${title}.`, frontmatter: Record<string, unknown> = {}) => ({ type: 'person' as const, title, compiled_truth: body, timeline: '', frontmatter });
const today = () => new Date().toISOString().slice(0, 10);

async function brief(engine: BrainEngine, counterparty: string) {
  const out = await dispatchToolCall(engine, 'context_pack', { counterparty }, stdio());
  const text = out.content.map(c => c.text ?? '').join('\n');
  expect(out.isError === true ? text.slice(0, 400) : false).toBe(false);
  return text;
}

parityTest('a remote context_pack brief reads a readable counterparty\'s newest timeline entry and revision, and none of a hidden one', {
  methods: ['putPage', 'createVersion', 'addTimelineEntry', 'readBriefEntityPages', 'readBriefEditPage', 'readBriefTimelineEntry', 'readBriefPageVersions'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await engine.putPage('people/brief-edited', page('Brief Edited', 'Brief Edited runs the widget desk.'));
  await engine.createVersion('people/brief-edited', { sourceId: SRC });
  await engine.putPage('people/brief-edited', page('Brief Edited', 'Brief Edited runs the widget desk.\nBrief Edited joined the board of briefmarkopenco.'));
  await engine.putPage('people/brief-dated', page('Brief Dated'));
  await engine.addTimelineEntry('people/brief-dated', { date: today(), summary: 'Brief Dated opened an office', detail: 'in a new city' }, { sourceId: SRC });
  await engine.putPage('people/brief-private', page('Brief Private', 'Brief Private joined briefmarkprivateco.', { visibility: 'private' }));
  await engine.addTimelineEntry('people/brief-private', { date: today(), summary: 'Brief Private briefmarkprivateentry', detail: '' }, { sourceId: SRC });
  await engine.putPage('people/brief-readers', page('Brief Readers', 'Brief Readers joined briefmarkreadersco.', { readable_by: ['alice-example'] }));
  await engine.addTimelineEntry('people/brief-readers', { date: today(), summary: 'Brief Readers briefmarkreadersentry', detail: '' }, { sourceId: SRC });
  const edited = await brief(engine, 'people/brief-edited');
  const dated = await brief(engine, 'people/brief-dated');
  const hidden = await brief(engine, 'people/brief-private');
  const readers = await brief(engine, 'people/brief-readers');
  expect(edited).toContain('briefmarkopenco');
  expect(dated).toContain('opened an office');
  expect(`${hidden}\n${readers}`).not.toMatch(/briefmark(private|readers)/);
  const view = (t: string) => t.replace(/"?(generated_at|now)"?:\s*"[^"]*"/g, '').replace(/\s+/g, ' ');
  return { edited: view(edited), dated: view(dated), hidden: view(hidden), readers: view(readers) };
});
