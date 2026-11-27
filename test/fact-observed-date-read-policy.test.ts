/**
 * GBRA-574 A1: a fact row's `observed` date (when it was said: the observation date of the page it was taken from) is
 * read under the caller's own page read policy on every path that prints it, and a failed read marks the response
 * degraded instead of passing `observed unknown` off as a fact. PGLite, keyword-only, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { EVIDENCE_DATE_HEADER_KEY, factObservationDates } from '../src/core/search/evidence-date.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

let engine: PGLiteEngine;
let sourceId: string;
const Q = 'Where is the Forge offsite venue booked?';
const facts = () => [
  { id: 1, source_id: sourceId, entity_slug: 'forge', source_markdown_slug: 'conversations/open-chat' },
  { id: 2, source_id: sourceId, entity_slug: 'forge', source_markdown_slug: 'conversations/team-chat' },
  { id: 3, source_id: sourceId, entity_slug: 'forge', source_markdown_slug: 'conversations/secret-chat' },
  { id: 4, source_id: sourceId, entity_slug: 'conversations/open-chat', source_markdown_slug: 'conversations/open-chat' },
];
const read = (access: Parameters<typeof withCallerAccess>[0] | null) => {
  const run = () => factObservationDates(engine, facts(), null, access ? { sourceIds: [sourceId], excludePrivate: true } : { sourceIds: [sourceId] });
  return access ? withCallerAccess(access, run) : run();
};
const call = async (name: string, params: Record<string, unknown>, remote: boolean) => {
  const auth = { token: 't', clientId: 'observed-date', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const r = await dispatchToolCall(engine, name, params,
    { remote, transport: 'stdio', sourceId, ...(remote ? { auth } : {}), config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n') + '\n' + JSON.stringify(r._meta ?? {});
};
/** Runs `fn` with every observation-date page read failing (`this` kept: a transaction scope inherits the method). */
async function observationReadFails<T>(fn: () => Promise<T>): Promise<T> {
  // The observed-date page read is the typed member readAdmittedPageDateFields; a database error there (not a refusal)
  // must still read as "observed unknown" with the response marked degraded.
  engine.readAdmittedPageDateFields = (() => Promise.reject(new Error('observation read failed'))) as typeof engine.readAdmittedPageDateFields;
  try { return await fn(); } finally { delete (engine as { readAdmittedPageDateFields?: unknown }).readAdmittedPageDateFields; }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, 'conversations/open-chat', page('conversation', 'Open chat', '**User:** The Forge offsite venue changed.', 'date: 2025-02-01\n'));
  await putPage(engine, sourceId, 'conversations/team-chat', page('conversation', 'Team chat', '**User:** The Forge offsite venue changed again.', 'date: 2025-03-01\nreadable_by: [alice-example]\n'));
  await putPage(engine, sourceId, 'conversations/secret-chat', page('conversation', 'Secret chat', '**User:** Another venue.', 'date: 2025-04-01\nvisibility: private\n'));
  const fact = (text: string, slug: string) => engine.executeRaw(
    "INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug) VALUES ($1, 'forge', $2, 'event', 'conversation', 'world', 1, '2025-06-02T00:00:00Z', $3)",
    [sourceId, text, slug]);
  await fact('The Forge offsite venue is booked in Missoula.', 'conversations/open-chat');
  await fact('The Forge offsite venue is booked in Taos.', 'conversations/team-chat');
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('factObservationDates reads under the caller policy', () => {
  test('a local caller reads every source page date; a fact on its own entity page has none', async () => {
    expect([...(await read(null)).entries()]).toEqual([[1, '2025-02-01'], [2, '2025-03-01'], [3, '2025-04-01']]);
  });

  test('a remote caller gets no date from a private page or a readable_by page that does not name it', async () => {
    expect([...(await read({ identity: [] })).entries()]).toEqual([[1, '2025-02-01']]);
  });

  test('a member-scoped caller reads the date of a readable_by page that names it, and only that', async () => {
    expect([...(await read({ identity: ['member:alice-example'] })).entries()]).toEqual([[1, '2025-02-01'], [2, '2025-03-01']]);
    expect([...(await read({ identity: ['member:bob-example'] })).entries()]).toEqual([[1, '2025-02-01']]);
  });
});

describe('query facts block', () => {
  test('a remote caller sees when the readable fact was said, and nothing of the restricted page', async () => {
    const text = await call('query', { query: Q, expand: false, limit: 6, token_budget: 3000 }, true);
    expect(text).toContain('[observed 2025-02-01; valid 2025-06-02 to unknown]');
    expect(text).not.toContain('2025-03-01');
    expect(text).not.toContain('Taos');
    expect(text).not.toContain('fact_observed_date_unavailable');
  });

  test('a failed observation read renders observed unknown and marks the response degraded', async () => {
    const text = await observationReadFails(() => call('query', { query: Q, expand: false, limit: 6, token_budget: 3000 }, true));
    expect(text).toContain('[observed unknown; valid 2025-06-02 to unknown]');
    expect(text).toContain('fact_observed_date_unavailable');
  }, 60_000);
});

describe('recall date headers', () => {
  test('a failed observation read reports facts_degraded instead of a silent unknown', async () => {
    await engine.setConfig(EVIDENCE_DATE_HEADER_KEY, 'true');
    try {
      const ok = await call('recall', { entity: 'forge' }, false);
      expect(ok).toContain('[observed 2025-02-01; valid 2025-06-02 to unknown]');
      expect(ok).not.toContain('fact_observed_date_unavailable');
      const failed = await observationReadFails(() => call('recall', { entity: 'forge' }, false));
      expect(failed).toContain('[observed unknown; valid 2025-06-02 to unknown]');
      expect(failed).toContain('fact_observed_date_unavailable');
    } finally { await engine.setConfig(EVIDENCE_DATE_HEADER_KEY, 'false'); }
  }, 60_000);
});
