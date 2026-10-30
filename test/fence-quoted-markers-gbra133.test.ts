/**
 * GBRA-133: a transcript page that quotes the fence markers (a conversation about gbrain itself) is not a broken fence.
 * Every fence writer puts a marker on its own line, so marker text with other text on its line (a sentence, a
 * blockquote's `>`) is quoted and opens, closes or repeats nothing. Before the fix, 13 quoted begins held the page
 * `invalid_fence` (repeated_marker at the line of a quoted mention, where no marker line exists), and one unmatched quoted
 * begin held it as unbalanced.
 *
 * Protects:
 * - the readers (parseTakesFence, parseFactsFence, the strict compile gate) and the content-repair lane's fence
 *   extraction ignore quoted markers, and a real fence among them still parses;
 * - a real broken fence still parses as broken (an own-line begin with no end warns unbalanced) and a repeated own-line
 *   begin still holds repeated_marker, at the repeat's line; the hold's file line is that marker's line in the file;
 * - put_page on a repo-less brain and on a managed brain with Git stores the transcript and refuses the broken page at the
 *   repeated marker's body line, and a
 *   managed sync imports the transcript file and holds the broken one (PGLite and Postgres).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { strikeFenceRow } from '../src/core/facts/forget.ts';
import { dropFactFenceRowsByNumber } from '../src/core/facts/purge-overlay.ts';
import { withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../src/core/takes-fence.ts';
import { strictFailures } from '../src/core/fence-repair/page-checks.ts';
import { extractRawRows } from '../src/core/fence-repair/raw-rows.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const HEADER = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const ROW = '| 1 | a durable hunch | take | brain | 0.8 | 2026-04 | note |';
/** A transcript that quotes every marker: inline in prose 13 times, in a blockquote, as a two-dash near miss, and once unmatched before EOF. */
const transcript = () => [
  'User: How do takes get stored in a page?',
  ...Array.from({ length: 12 }, (_, i) => `Assistant: step ${i + 1}: gbrain writes ${TAKES_FENCE_BEGIN} on its own line, then the table, then ${TAKES_FENCE_END}.`),
  `User: and facts use ${FACTS_FENCE_BEGIN} with ${FACTS_FENCE_END} the same way?`,
  `> ${TAKES_FENCE_BEGIN}`,
  `> ${FACTS_FENCE_END}`,
  'Assistant: a two-dash <!-- gbrain:takes:begin --> written from memory is a near miss.',
  `User: so a page that ends with ${TAKES_FENCE_BEGIN} and nothing after it is broken?`,
].join('\n');
const realFence = [TAKES_FENCE_BEGIN, HEADER, ROW, TAKES_FENCE_END].join('\n');
/** A real broken fence the normalizer cannot fix: a second own-line begin inside the fence (repeated_marker). */
const repeatedBegin = [TAKES_FENCE_BEGIN, HEADER, ROW, TAKES_FENCE_BEGIN, HEADER, '| 2 | another hunch | take | brain | 0.5 | 2026-04 | note |', TAKES_FENCE_END].join('\n');
const secondBeginLine = (text: string) => { const lines = text.split('\n'); const first = lines.indexOf(TAKES_FENCE_BEGIN); return lines.indexOf(TAKES_FENCE_BEGIN, first + 1) + 1; };
const file = (body: string) => `---\ntitle: Example transcript\ntype: note\n---\n${body}\n`;
const lineOf = (text: string, needle: string) => text.split('\n').findIndex(line => line === needle) + 1;

describe('quoted markers are not fence lines', () => {
  test('a transcript quoting every marker parses as no fence, passes the strict gate and gives the repair lane nothing', () => {
    const body = transcript();
    expect(parseTakesFence(body)).toMatchObject({ takes: [], warnings: [] });
    expect(parseFactsFence(body).warnings).toEqual([]);
    expect(strictFailures({ compiled_truth: body, timeline: '' })).toEqual([]);
    expect(extractRawRows(body)).toMatchObject({ fences: [], issues: [] });
  });

  test('a real fence among quoted markers parses its row', () => {
    const body = `${transcript()}\n\n${realFence}`;
    const parsed = parseTakesFence(body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.takes.map(take => take.claim)).toEqual(['a durable hunch']);
    expect(strictFailures({ compiled_truth: body, timeline: '' })).toEqual([]);
    expect(extractRawRows(body).fences.map(fence => [fence.kind, fence.issues])).toEqual([['takes', []]]);
  });

  test('an own-line begin with no end still holds, at the marker line', () => {
    const body = `${transcript()}\n\n${TAKES_FENCE_BEGIN}\n${HEADER}\n${ROW}`;
    expect(parseTakesFence(body).warnings).toEqual(['TAKES_FENCE_UNBALANCED: missing begin or end marker']);
    expect(strictFailures({ compiled_truth: body, timeline: '' })).toEqual([{ section: 'body', fence: 'takes', check: 'warnings', rows: [] }]);
    const [fence] = extractRawRows(body).fences;
    expect(fence!.begin.line).toBe(lineOf(body, TAKES_FENCE_BEGIN));
    expect(fence!.end).toBeNull();
  });

  test('an own-line begin repeated still holds repeated_marker, at the repeat\'s line', () => {
    const body = `${transcript()}\n\n${realFence}\n\nMore notes.\n\n${realFence}`;
    const lines = body.split('\n');
    const second = lines.findIndex((line, i) => line === TAKES_FENCE_BEGIN && i > lines.indexOf(TAKES_FENCE_BEGIN)) + 1;
    expect(strictFailures({ compiled_truth: body, timeline: '' })).toContainEqual({ section: 'body', fence: 'takes', check: 'repeated_marker', rows: [] });
    const primary = extractRawRows(body).fences.find(fence => fence.primary)!;
    expect(primary.issues[0]).toMatchObject({ reason: 'repeated_marker', line: second });
  });

  test('a marker in a code span or a fenced code block stays quoted, as before', () => {
    const body = ['Use `' + TAKES_FENCE_BEGIN + '` to open.', '```markdown', TAKES_FENCE_BEGIN, '```'].join('\n');
    expect(parseTakesFence(body).warnings).toEqual([]);
    expect(extractRawRows(body)).toMatchObject({ fences: [], issues: [] });
  });
});

const backends = testBackends();
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

for (const backend of backends) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  test(`managed sync [${backend}]: the transcript file imports; the broken file holds invalid_fence at its repeated marker's file line`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const broken = file(`${transcript()}\n\n${repeatedBegin}`);
    writeFileSync(join(root, 'notes/transcript.md'), file(transcript()));
    writeFileSync(join(root, 'notes/broken.md'), broken);
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'transcripts');
    await performManagedSync(engine, OPTS);
    const holds = (await engine.executeRaw<{ r: { path: string; code: string; meta: { line?: number } } }>(
      "SELECT completed_keys->0 AS r FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint")).map(({ r }) => [r.path, r.code, r.meta.line]);
    expect(holds).toEqual([['notes/broken.md', 'invalid_fence', secondBeginLine(broken)]]);
    const [stored] = await engine.executeRaw<{ t: string }>("SELECT compiled_truth AS t FROM pages WHERE source_id='default' AND slug='notes/transcript'");
    expect(stored?.t).toContain('Assistant: step 12');
  }, { databaseUrl, setup: ({ root }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, 'notes/seed.md'), file('A seed note.')); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  } }), 180_000);
}

const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-quoted-fence-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const putPage = operations.find(op => op.name === 'put_page')!;
const put = (ctx: OperationContext, slug: string, content: string): Promise<Record<string, any>> =>
  (putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 25_000 }) as Promise<Record<string, any>>)
    .catch((e: { code?: string; message?: string }) => ({ thrown: e.code, message: e.message }));

/** A source per run: repo-less (no Git) or a managed checkout with Git. */
async function brain(managed: boolean, run: (ctx: OperationContext, engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-quoted-fence-'));
    const root = join(dir, 'brain');
    mkdirSync(root);
    const sourceId = `source-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        if (managed) { writeFileSync(join(root, '.gitignore'), 'tmp/\n'); durableGitRepo(root, ['.gitignore']); }
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run({ engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, engine);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

for (const managed of [false, true]) describe(`${managed ? 'managed brain with a Git checkout' : 'repo-less brain'}: put_page of a quoting transcript`, () => {
  test('the transcript is stored; a repeated own-line begin is refused repeated_marker at the marker\'s body line', () => brain(managed, async (ctx, engine) => {
    const stored = await put(ctx, 'notes/transcript', file(transcript()));
    expect(stored.thrown).toBeUndefined();
    expect((await engine.readPageSnapshot('notes/transcript', { sourceId: ctx.sourceId! }))?.page.compiled_truth).toContain('Assistant: step 12');
    const refused = await put(ctx, 'notes/broken', file(`${transcript()}\n\n${repeatedBegin}`));
    expect(refused.thrown).toBe('invalid_params');
    expect(refused.message).toStartWith(`Fence repeated_marker: in the takes fence (body), at line ${secondBeginLine(`${transcript()}\n\n${repeatedBegin}`)}.`);
    expect(await engine.readPageSnapshot('notes/broken', { sourceId: ctx.sourceId! })).toBeNull();
  }), 120_000);
});

describe('fence writers find the fence the readers find', () => {
  const fact = (rowNum: number, claim: string): ParsedFact => ({ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    validFrom: '2026-01-01', source: 'note', context: '', active: true } as ParsedFact);
  const table = renderFactsTable([fact(1, 'alpha claim'), fact(2, 'beta claim')]);
  const prose = 'Prose between a quoted marker and the real fence that every writer keeps.';
  const quotedBegin = `Intro.\n\nUser said: ${FACTS_FENCE_BEGIN} goes on its own line.\n\n${prose}\n\n## Facts\n\n${table}\n\nTail.`;
  const strike = (f: ParsedFact): ParsedFact => ({ ...f, active: false, context: 'withdrawn' });

  test('forgetting a row rewrites only the real fence, never the prose after a quoted begin', () => {
    const struck = strikeFenceRow(quotedBegin, 1, strike)!;
    expect(struck.slice(0, struck.indexOf('## Facts'))).toBe(quotedBegin.slice(0, quotedBegin.indexOf('## Facts')));
    expect(parseFactsFence(struck).facts.map(f => [f.rowNum, f.active])).toEqual([[1, false], [2, true]]);
    expect(strictFailures({ compiled_truth: struck, timeline: '' })).toEqual([]);
  });

  test('a quoted end inside the real fence does not cut it short when a row is forgotten', () => {
    const lines = table.split('\n');
    const body = ['Intro.', '', ...lines.slice(0, -2), `> quoted ${FACTS_FENCE_END}`, ...lines.slice(-2), '', 'Tail.'].join('\n');
    const struck = strikeFenceRow(body, 1, strike)!;
    expect(struck.split(FACTS_FENCE_END).length - 1).toBe(1);
    expect(parseFactsFence(struck).facts.map(f => [f.rowNum, f.active])).toEqual([[1, false], [2, true]]);
    expect(struck.endsWith('\n\nTail.')).toBe(true);
  });

  test('withdrawal and purge on a stored body start at the real begin and keep the prose', () => {
    expect(withdrawalFenceBlocks(quotedBegin).map(block => block.start)).toEqual([quotedBegin.indexOf(FACTS_FENCE_BEGIN, quotedBegin.indexOf('## Facts'))]);
    const purged = dropFactFenceRowsByNumber(quotedBegin, row => row.rowNum !== 1);
    expect(purged).toContain(prose);
    expect(purged.slice(0, purged.indexOf('## Facts'))).toBe(quotedBegin.slice(0, quotedBegin.indexOf('## Facts')));
    expect(parseFactsFence(purged).facts.map(f => f.claim)).toEqual(['beta claim']);
    // With no real begin, the quoted one opens nothing: a purge leaves the quote, the prose and the unfenced rows alone.
    const noRealBegin = `Intro.\n\nUser said: ${FACTS_FENCE_BEGIN} goes on its own line.\n\n${prose}\n\n${table.split('\n').slice(1).join('\n')}\n\nTail.`;
    expect(withdrawalFenceBlocks(noRealBegin)).toEqual([]);
    expect(dropFactFenceRowsByNumber(noRealBegin, row => row.rowNum !== 1)).toBe(noRealBegin);
    const quotedInBlockquote = noRealBegin.replace(`User said: ${FACTS_FENCE_BEGIN} goes on its own line.`, `> ${FACTS_FENCE_BEGIN}`);
    expect(withdrawalFenceBlocks(quotedInBlockquote)).toEqual([]);
    expect(dropFactFenceRowsByNumber(quotedInBlockquote, row => row.rowNum !== 1)).toBe(quotedInBlockquote);
    // A label before the marker (`Facts: <marker>`) still opens a fence, for the readers and the purge alike.
    const labelled = noRealBegin.replace(` goes on its own line.\n\n${prose}`, '');
    expect(parseFactsFence(labelled).facts.map(f => f.claim)).toEqual(['alpha claim', 'beta claim']);
    expect(withdrawalFenceBlocks(labelled).map(block => block.start)).toEqual([labelled.indexOf(FACTS_FENCE_BEGIN)]);
  });

  test('a megabyte line of quoted markers is read in one pass', () => {
    const line = Array.from({ length: 32_000 }, () => `say ${TAKES_FENCE_BEGIN} ok`).join(' ');
    const body = `${line}\n\n${realFence}\n`;
    const started = performance.now();
    expect(parseTakesFence(body).takes.length).toBe(1);
    expect(strictFailures({ compiled_truth: body, timeline: '' })).toEqual([]);
    // gstack-timing-ok: one pass takes about 15 ms here; the per-marker line scan this replaces took minutes on this body
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
