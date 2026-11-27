/**
 * GST-4020 (rebuilds #10435 and #10332 with the cases review found): what extract_atoms reads and when it skips.
 *
 * - #10435: an edit that leaves the extraction input unchanged (a takes or private facts row) makes no model call; the
 *   page is stamped against a digest of its input stored with the successful scan, the reused atoms move to the page's
 *   current hash, and doctor's atom_provenance_drift stays quiet after more than 20 such edits.
 * - The skip is bound to the latest successful scan: reverting to older prose after a newer extraction (with the
 *   extraction watermark gone, as a failed fail-soft write leaves it) extracts again.
 * - #10332: the input is the canonical body: a withdrawn claim never reaches the model, and a withdrawal recorded after
 *   an extraction (content hash unchanged) re-extracts and retires the atom that carried it.
 * - A world fence row held narrower (GST-2891) never reaches the model or a world atom.
 * - A page renamed in place and made confidential leaves no atom a remote get_page serves as world.
 * PGLite and Postgres (repo-less), unmanaged cycle phase with page discovery.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { HIDDEN_TAKE_ROW, WORLD_PAGE_BODY } from './helpers/world-fence-page.ts';

const SLUG = 'notes/launch-review';
const PROSE = (marker: string) => `# Launch review\n\n${`The review of ${marker} found that the team measures every launch against clear exit criteria. `.repeat(10)}`;
const fact = (rowNum: number, claim: string, visibility = 'world'): ParsedFact => ({ rowNum, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true } as ParsedFact);
const CANARIES = ['canaryalpha3301', 'canarybeta3302', 'canarywithdrawn3303', 'canaryheld3304', 'canaryretained3305', 'canaryrename3306'];

/** A model that returns one atom per canary it is shown, quoting the sentence that holds it, plus one fixed atom. */
function copyingChat(empty = false) {
  const prompts: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    const last = opts.messages[opts.messages.length - 1]!;
    const prompt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    prompts.push(prompt);
    const seen = CANARIES.filter(c => prompt.includes(c));
    const atoms = empty ? [] : [{ title: 'Measure every launch', body: 'Measure every launch against clear exit criteria.', atom_type: 'insight' },
      ...seen.map(c => ({ title: `Recorded ${c}`, body: `The page records ${c}.`, atom_type: 'insight', source_quote: c }))];
    const text = JSON.stringify(atoms);
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { prompts, chat };
}

const liveAtoms = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ slug: string; text: string; visibility: string | null; source_hash: string | null }>(
  `SELECT slug, title || ' ' || compiled_truth || ' ' || COALESCE(frontmatter->>'source_quote','') AS text, frontmatter->>'visibility' AS visibility,
     frontmatter->>'source_hash' AS source_hash FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
const put = (engine: BrainEngine, sourceId: string, body: string, frontmatter: Record<string, unknown> = {}, slug = SLUG) =>
  engine.putPage(slug, { type: 'note', title: 'Launch review', compiled_truth: body, timeline: '', frontmatter }, { sourceId });
const run = (engine: BrainEngine, sourceId: string, chat: ReturnType<typeof copyingChat>['chat']) => runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [] });

describe('GST-4020 extract_atoms input and skip', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  let n = 0;
  const fresh = async (backend: string, engine: BrainEngine) => {
    const sourceId = `gst4020-${backend}-${++n}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    return sourceId;
  };

  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterAll(async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });

  test('#10435: fence-only edits make no model call, keep the atoms on the current hash, and leave doctor quiet past 20 edits', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      await put(engine, sourceId, WORLD_PAGE_BODY);
      const first = copyingChat();
      expect((await run(engine, sourceId, first.chat)).status, backend).toBe('ok');
      expect(first.prompts.length, backend).toBe(1);
      const before = (await liveAtoms(engine, sourceId)).map(a => a.slug);
      expect(before.length, backend).toBeGreaterThan(0);
      for (let i = 2; i <= 23; i++) {
        const edited = WORLD_PAGE_BODY.replace(`| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |`,
          `| 1 | ${HIDDEN_TAKE_ROW} | take | brain | 0.6 | 2026-01 | test |\n| 2 | Acme-example will hire reviewer ${i} | take | brain | 0.7 | 2026-02 | test |`);
        await put(engine, sourceId, edited);
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
        const again = copyingChat();
        expect((await run(engine, sourceId, again.chat)).status, backend).toBe('ok');
        expect(again.prompts.length, `${backend} edit ${i}`).toBe(0);
        expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
      }
      const after = await liveAtoms(engine, sourceId);
      expect(after.map(a => a.slug), backend).toEqual(before);
      const [page] = await engine.executeRaw<{ h: string }>('SELECT substring(content_hash from 1 for 16) AS h FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, SLUG]);
      for (const atom of after) expect(atom.source_hash, backend).toBe(page!.h);
      const drift = await computeAtomProvenanceDriftCheck(engine);
      expect((drift.details as { drifted?: number }).drifted ?? 0, backend).toBe(0);
    }
  }, 240_000);

  test('a revert to older prose after a newer extraction extracts again, even with the watermark gone', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      await put(engine, sourceId, PROSE('canaryalpha3301'));
      const chat = copyingChat();
      await run(engine, sourceId, chat.chat);
      await put(engine, sourceId, PROSE('canarybeta3302'));
      await run(engine, sourceId, chat.chat);
      expect(chat.prompts.length, backend).toBe(2);
      await engine.executeRaw(`DELETE FROM page_extraction_state WHERE pipeline='extract_atoms'`);
      await put(engine, sourceId, PROSE('canaryalpha3301'));
      await run(engine, sourceId, chat.chat);
      expect(chat.prompts.length, backend).toBe(3);
      const text = (await liveAtoms(engine, sourceId)).map(a => a.text).join('\n');
      expect(text, backend).toContain('canaryalpha3301');
      expect(text, backend).not.toContain('canarybeta3302');
    }
  }, 120_000);

  test('#10332: a withdrawal recorded after extraction re-extracts from the canonical body and retires the withdrawn claim', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      const withdrawn = 'Acme-example withdrawn launch claim canarywithdrawn3303', retained = 'Acme-example retained launch claim canaryretained3305';
      await put(engine, sourceId, `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, withdrawn), fact(2, retained)])}`);
      const chat = copyingChat();
      await run(engine, sourceId, chat.chat);
      expect((await liveAtoms(engine, sourceId)).map(a => a.text).join('\n'), backend).toContain('canarywithdrawn3303');
      await engine.executeRaw('INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES($1,$2,$3,gbrain_fact_fingerprint($4))', [sourceId, 'world', SLUG, withdrawn]);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
      await run(engine, sourceId, chat.chat);
      expect(chat.prompts.length, backend).toBe(2);
      expect(chat.prompts[1], backend).not.toContain('canarywithdrawn3303');
      expect(chat.prompts[1], backend).toContain('canaryretained3305');
      const text = (await liveAtoms(engine, sourceId)).map(a => a.text).join('\n');
      expect(text, backend).not.toContain('canarywithdrawn3303');
      expect(text, backend).toContain('canaryretained3305');
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
    }
  }, 120_000);

  test('a world fence row held narrower never reaches the model or an atom', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      const held = 'Alice-example keeps bees canaryheld3304';
      await put(engine, sourceId, `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, held), fact(2, 'Acme-example retained launch claim canaryretained3305')])}`);
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num)
        VALUES ($1, 'people/alice-example', $2, 'fact', 'private', 'test', $3, 1)`, [sourceId, held, SLUG]);
      const chat = copyingChat();
      await run(engine, sourceId, chat.chat);
      expect(chat.prompts.length, backend).toBe(1);
      expect(chat.prompts[0], backend).not.toContain('canaryheld3304');
      expect(chat.prompts[0], backend).toContain('canaryretained3305');
      expect((await liveAtoms(engine, sourceId)).map(a => a.text).join('\n'), backend).not.toContain('canaryheld3304');
    }
  }, 120_000);

  test('a page renamed in place and made confidential leaves no atom a remote get_page serves', async () => {
    const { engine } = engines.find(e => e.backend === 'pglite') ?? engines[0]!;
    for (const variant of ['prose unchanged', 'prose edited'] as const) {
      const sourceId = await fresh(`rename-${variant.replace(' ', '-')}`, engine);
      const body = PROSE('canaryrename3306');
      await put(engine, sourceId, body);
      await run(engine, sourceId, copyingChat().chat);
      const atoms = await liveAtoms(engine, sourceId);
      expect(atoms.length, variant).toBeGreaterThan(0);
      for (const atom of atoms) expect(atom.visibility, variant).toBe('world');
      await renamePageOntoSlug(engine, { sourceId, oldSlug: SLUG, newSlug: 'notes/launch-review-renamed', to: 'notes/launch-review-renamed.md' });
      await put(engine, sourceId, variant === 'prose unchanged' ? body : `${body}\n\nOne more line.`, { access: 'confidential' }, 'notes/launch-review-renamed');
      await run(engine, sourceId, copyingChat().chat);
      for (const atom of await liveAtoms(engine, sourceId)) {
        const out = await dispatchToolCall(engine, 'get_page', { slug: atom.slug }, { remote: true, transport: 'stdio', sourceId, takesHoldersAllowList: ['world'] });
        expect(out.content.map(c => c.text).join('\n'), `${variant} ${atom.slug}`).not.toContain('records canaryrename3306');
      }
    }
  }, 120_000);
});
