/**
 * Shared seed and caller for the served parity files of reads whose scope comes from arguments the client chose
 * (served-arg-reads-*.test.ts): a brain with an owner and a member, a world page, a private page and a readers-only page that
 * each carry their own marker, facts and links around one entity, and the remote caller that reads it through the real MCP
 * dispatch on the stdio path.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { chunk } from '../engine-parity/chunk-fixtures.ts';
import { basisEmbedding, createMember, type ParityBackend } from '../engine-parity/harness.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { fenceClaimHashes } from '../../src/core/facts/withdrawal-overlay.ts';
import { bodyColumns, flipInput, pageMeta, segmentText, stageGeneration } from './page-body-fixtures.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

/** The remote caller of the served route: a stdio client, world rows only, `stdioMember` set to read as a member. */
export const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;

export const PRIVATE_MARK = 'privatemarkzq';
export const READERS_MARK = 'readersmarkzq';
export const ALICE = 'alice-example';
export const BOB = 'bob-example';

export function installFakeEmbedder(): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from(basisEmbedding(0))) })) as never);
}

export function removeFakeEmbedder(): void {
  __setEmbedTransportForTests(null);
  resetGateway();
}

/** One page with its sealed chunks (one per text; the body when none is given). */
export async function put(engine: BrainEngine, slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}, chunks?: string[]): Promise<void> {
  await engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter }, { sourceId: 'default' });
  await engine.sealChunks(slug, (chunks ?? [body]).map((text, i) => chunk(i, text)));
}

export async function seedMembers(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createMember(engine, backend, { id: ALICE, email: 'alice@example.com' });
  await createMember(engine, backend, { id: BOB });
  await setOwner(engine, ALICE);
}

const link = (engine: BrainEngine, from: string, to: string) =>
  engine.addLink(from, to, 'about', 'references', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });

/** The fact row a remote read can reach; `src` is the page it came from, `vis` its visibility, `n` its row number and valid-from day. */
const fact = (text: string, vis: string, entity: string, src: string, n: number) => ({
  fact: text, kind: 'fact', visibility: vis, source: 'cli:extract-conversation-facts:chat', source_session: 's1', entity_slug: entity,
  source_markdown_slug: src, row_num: n, embedding: basisEmbedding(0), embedding_model: 'text-embedding-3-small', dimension: 'location',
  value: `city${n}`, valid_from: new Date(Date.UTC(2026, 4, n)),
});

/**
 * People, notes, links, facts: the entity `people/alice-example` with a world note that mentions it, a private note and a
 * readers-only note (unless `readersOnlyPage` is false: a readers list makes the brain restricted) that mention it too (each with its marker), a five-chunk note, a conversation page, and facts from the
 * world note and the conversation (a later one that calls a trip off), a private fact, and two entities that share one claim.
 */
export async function seedEntityBrain(engine: BrainEngine, opts: { readersOnlyPage?: boolean } = {}): Promise<void> {
  const readersOnlyPage = opts.readersOnlyPage ?? true;
  await put(engine, 'people/alice-example', 'person', 'Alice Example', '# Alice Example\n\nAlice Example runs probemark things.');
  await put(engine, 'people/bob-example', 'person', 'Bob Example', 'Bob Example probemark.');
  await put(engine, 'notes/world-ref', 'note', 'World ref', 'probemark mentions Alice Example');
  await put(engine, 'notes/priv-ref', 'note', 'Private ref', `probemark mentions Alice Example ${PRIVATE_MARK}`, { visibility: 'private' });
  if (readersOnlyPage) await put(engine, 'notes/readers-ref', 'note', 'Readers ref', `probemark mentions Alice Example ${READERS_MARK}`, { readable_by: [ALICE] });
  await put(engine, 'notes/multi', 'note', 'Multi', 'probemark a', {}, ['probemark one', 'probemark two', 'probemark three', 'probemark four', 'probemark five']);
  await put(engine, 'chat/conv-1', 'conversation', 'Conv 1', 'we talked about probemark tea trip', { date: '2026-05-01' });
  for (const from of ['notes/world-ref', 'notes/priv-ref', ...readersOnlyPage ? ['notes/readers-ref'] : []]) await link(engine, from, 'people/alice-example');
  await engine.insertFacts([
    fact('Alice likes probemark tea trip', 'world', 'people/alice-example', 'chat/conv-1', 1),
    fact('Alice probemark tea trip was called off', 'world', 'people/alice-example', 'chat/conv-1', 3),
    fact('same dup claim probemark', 'world', 'people/alice-example', 'notes/world-ref', 4),
    fact('same dup claim probemark', 'world', 'people/bob-example', 'notes/world-ref', 5),
    fact(`Alice secret probemark ${PRIVATE_MARK}`, 'private', 'people/alice-example', 'notes/priv-ref', 2),
  ] as never, { source_id: 'default' });
}

/** What a remote call answered, as text: its JSON when it parses, a typed refusal as `{ refused }` (so an arm that refuses differs from one that answers). */
export async function call(engine: BrainEngine, tool: string, params: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<unknown> {
  let out;
  try {
    out = await dispatchToolCall(engine, tool, params, { ...STDIO, ...ctx } as never);
  } catch (e) {
    return { refused: String((e as { code?: string }).code ?? e) };
  }
  const text = out.content.map(part => (part as { text?: string }).text ?? '').join('');
  let body: unknown = text;
  try { body = JSON.parse(text.includes('[gbrain') ? text.slice(0, text.indexOf('[gbrain')) : text); } catch { /* plain text */ }
  if (!out.isError) return body;
  const code = (body as { code?: string; error?: string } | null)?.code ?? (body as { error?: string } | null)?.error;
  return { error: code ?? text.slice(0, 200) };
}

const VOLATILE = /(^id$|_id$|_at$|^at$|_ms$|revision|hash|stamp|took|elapsed|^score|distance|similarity|rank)/i;

/** A copy of an answer without the fields that differ per arm for no reason a caller sees: row ids, write times, hashes, scores. */
export function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, stable(v)]));
  }
  // A write time (a page's updated time, a card's since) differs per arm; a seeded midnight date does not.
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?!00:00:00(\.0+)?Z)[\d:.]+Z$/.test(value)) return '<time>';
  // A fact id comes from a sequence the Postgres arm does not reset between cases, so the quoted-excerpt label is normalized.
  if (typeof value === 'string' && /excerpt from fact \d+;/.test(value)) return value.replace(/excerpt from fact \d+;/g, 'excerpt from fact N;');
  return typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1e4) / 1e4 : value;
}

/** True when `answer` carries a marker of a page the caller may not read. */
export const leaks = (answer: unknown): string[] => [PRIVATE_MARK, READERS_MARK].filter(mark => JSON.stringify(answer).includes(mark));

export const KEPT_CLAIM = 'Carol Seg runs the platform team';
export const PURGED_CLAIM = 'Carol Seg prefers written agendas';
const factRow = (rowNum: number, claim: string) => ({ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true });

/** The text of `people/carol-seg`: a lead and a facts fence with a kept claim and a claim a global purge withdraws. */
export const segmentedBody = (): string =>
  `# Carol Seg\n\nCarol Seg leads the segmented probemark page.\n\n## Facts\n\n${renderFactsTable([factRow(1, KEPT_CLAIM), factRow(2, PURGED_CLAIM)] as never)}\n`;

/**
 * `people/carol-seg` as a segmented page (one stored segment, lead = the whole text) through typed members only, and a purge
 * of PURGED_CLAIM under subject `*`: reading the page's lead overlays the purge, which reads it through listGlobalPurgeWithdrawals.
 */
export async function seedSegmentedPageWithPurge(engine: BrainEngine): Promise<void> {
  const text = segmentedBody();
  const texts = [segmentText(text)];
  const meta = pageMeta('Carol Seg');
  const { id: pageId } = await engine.createSegmentedPageShell('people/carol-seg', { ...meta, type: 'person' as never }, { sourceId: 'default' });
  const staged = await stageGeneration(engine, { pageId, slug: 'people/carol-seg', genFrom: 1, texts });
  await engine.transaction(async tx => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, texts, { meta: { ...meta, type: 'person' as never }, body: bodyColumns(texts, { truth_lead: text }) }));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
  });
  const purged = await engine.normalizeFenceLines([`## Facts\n\n${renderFactsTable([factRow(2, PURGED_CLAIM)] as never)}\n`], ['']);
  await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: fenceClaimHashes([purged[0]!.body ?? ''])[0]!,
    requestId: null, actor: 'test', reason: null } as never);
}

/** Every answer was given (no typed refusal and no error as a value); an answer named in `contains` quotes that text (an empty answer proves nothing). */
export function assertNotRefused(answers: Record<string, unknown>, contains: Record<string, string> = {}): void {
  for (const [name, answer] of Object.entries(answers)) {
    const text = JSON.stringify(answer);
    if (contains[name] !== undefined) expect(text, name).toContain(contains[name]);
    expect(text, name).not.toContain('refused');
    expect(text, name).not.toContain('"error"');
  }
}

/** As assertNotRefused, and no answer carries the marker of a page the caller may not read. */
export function assertAnswered(answers: Record<string, unknown>, contains: Record<string, string> = {}): void {
  assertNotRefused(answers, contains);
  for (const [name, answer] of Object.entries(answers)) expect(leaks(answer), name).toEqual([]);
}
