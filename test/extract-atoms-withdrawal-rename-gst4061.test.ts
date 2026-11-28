/**
 * GST-4061 (cases left after #10542): extract_atoms after a withdrawal and after a rename.
 *
 * 1. A withdrawal rescan that finds nothing retires the page's own atom whose verified quote the withdrawal removed
 *    from the page (GBRA-161 D4 narrowed: only a withdrawal recorded since the page's last scan, only an atom older
 *    than that withdrawal, only a quote the complete input no longer holds).
 * 2. A managed source offers a page again after a world withdrawal and extracts it from the canonical body.
 * 3. A withdrawal recorded while the run waits on an earlier page never reaches a later page's prompt.
 * 4. A page renamed into a restricted folder with its content unchanged is offered again, and the world atoms still
 *    named after its old slug are retired. A rename that leaves the page world stays settled (#7462).
 * 5. A managed page renamed into a restricted folder retires its old-slug generation through the managed writer.
 * 6. Approving a held world-fence row leaves the page settled until its next edit (recorded decision, see the test).
 * Also: a renamed-origin retirement planned against a generation another writer replaced retires nothing and leaves
 * the page offered.
 * PGLite (and Postgres when DATABASE_URL is set), repo-less.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { atomOwnerKey } from '../src/core/generations/adapters/atoms.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'notes/launch-review';
const RESTRICTED = 'restricted-example/launch-review';
const PROSE = (marker: string) => `# Launch review\n\n${`The review of ${marker} found that the team measures every launch against clear exit criteria. `.repeat(10)}`;
const fact = (rowNum: number, claim: string, visibility = 'world'): ParsedFact => ({ rowNum, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true } as ParsedFact);
const CANARIES = ['canaryalpha4061', 'canarybeta4061', 'canarywithdrawn4061', 'canaryretained4061', 'canaryrename4061', 'canaryheld4061'];
const WITHDRAWN = 'Acme-example withdrawn launch claim canarywithdrawn4061';
const RETAINED = 'Acme-example retained launch claim canaryretained4061';

/** A model that returns one atom per canary it is shown, quoting it, plus one fixed atom with no quote. */
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

const liveAtoms = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ slug: string; text: string; visibility: string | null; source_slug: string | null }>(
  `SELECT slug, title || ' ' || compiled_truth || ' ' || COALESCE(frontmatter->>'source_quote','') AS text, frontmatter->>'visibility' AS visibility,
     frontmatter->>'source_slug' AS source_slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
const atomText = async (engine: BrainEngine, sourceId: string) => (await liveAtoms(engine, sourceId)).map(a => a.text).join('\n');
const put = (engine: BrainEngine, sourceId: string, body: string, frontmatter: Record<string, unknown> = {}, slug = SLUG) =>
  engine.putPage(slug, { type: 'note', title: 'Launch review', compiled_truth: body, timeline: '', frontmatter }, { sourceId });
const run = (engine: BrainEngine, sourceId: string, chat: ReturnType<typeof copyingChat>['chat']) => runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [] });
const withdraw = (engine: BrainEngine, sourceId: string, claim: string, subject = SLUG) =>
  engine.executeRaw('INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES($1,$2,$3,gbrain_fact_fingerprint($4))', [sourceId, 'world', subject, claim]);
const restrictFolder = (engine: BrainEngine, sourceId: string) => proposeRevision(engine, sourceId,
  [{ id: 'restricted', prefix: 'restricted-example/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
const contentHash = async (engine: BrainEngine, sourceId: string, slug: string) => (await engine.executeRaw<{ h: string }>(
  'SELECT content_hash AS h FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]?.h;
/** What a remote world reader gets for each live atom. */
const remoteAtomText = async (engine: BrainEngine, sourceId: string) => {
  const out: string[] = [];
  for (const atom of await liveAtoms(engine, sourceId)) {
    const read = await dispatchToolCall(engine, 'get_page', { slug: atom.slug }, { remote: true, transport: 'stdio', sourceId, takesHoldersAllowList: ['world'] });
    out.push(read.content.map(c => c.text).join('\n'));
  }
  return out.join('\n');
};

describe('GST-4061 unmanaged extract_atoms after withdrawals and renames', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  let n = 0;
  const fresh = async (backend: string, engine: BrainEngine) => {
    const sourceId = `gst4061-${backend}-${++n}`;
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

  test('case 1: a withdrawal rescan that finds nothing retires the atom quoting the withdrawn claim and keeps the rest', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      await put(engine, sourceId, `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, WITHDRAWN)])}`);
      await run(engine, sourceId, copyingChat().chat);
      expect(await atomText(engine, sourceId), backend).toContain('canarywithdrawn4061');
      await withdraw(engine, sourceId, WITHDRAWN);
      const empty = copyingChat(true);
      await run(engine, sourceId, empty.chat);
      expect(empty.prompts.length, backend).toBe(1);
      expect(empty.prompts[0], backend).not.toContain('canarywithdrawn4061');
      const text = await atomText(engine, sourceId);
      expect(text, backend).not.toContain('canarywithdrawn4061');
      expect(text, backend).toContain('Measure every launch');
      expect(await remoteAtomText(engine, sourceId), backend).not.toContain('canarywithdrawn4061');
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
    }
  }, 120_000);

  test('case 1 boundary: an empty rescan with no withdrawal since the last scan retires nothing', async () => {
    const { engine } = engines.find(e => e.backend === 'pglite') ?? engines[0]!;
    const sourceId = await fresh('d4-boundary', engine);
    await put(engine, sourceId, `${PROSE('canaryalpha4061')}\n\n${renderFactsTable([fact(1, RETAINED)])}`);
    await run(engine, sourceId, copyingChat().chat);
    const before = await liveAtoms(engine, sourceId);
    await put(engine, sourceId, `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, RETAINED)])}`);
    await run(engine, sourceId, copyingChat(true).chat);
    expect((await liveAtoms(engine, sourceId)).map(a => a.slug)).toEqual(before.map(a => a.slug));
  }, 120_000);

  test('case 3: a withdrawal recorded while the run reads an earlier page never reaches a later page\'s prompt', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      const later = 'notes/b-later';
      await put(engine, sourceId, `${PROSE('canarybeta4061')}\n\n${renderFactsTable([fact(1, WITHDRAWN, 'world'), fact(2, RETAINED)])}`, {}, later);
      await put(engine, sourceId, PROSE('canaryalpha4061'), {}, 'notes/a-first');
      const inner = copyingChat();
      let first = true;
      const chat = async (opts: ChatOpts) => {
        if (first) { first = false; await withdraw(engine, sourceId, WITHDRAWN, later); }
        return inner.chat(opts);
      };
      await run(engine, sourceId, chat);
      expect(inner.prompts.length, backend).toBe(2);
      expect(inner.prompts[0], backend).toContain('canaryalpha4061');
      expect(inner.prompts[1], backend).toContain('canaryretained4061');
      expect(inner.prompts[1], backend).not.toContain('canarywithdrawn4061');
      expect(await atomText(engine, sourceId), backend).not.toContain('canarywithdrawn4061');
    }
  }, 120_000);

  test('case 4: a page renamed into a restricted folder with its content unchanged is offered again and its old world atoms retire', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = await fresh(backend, engine);
      await put(engine, sourceId, PROSE('canaryrename4061'));
      await run(engine, sourceId, copyingChat().chat);
      expect(await remoteAtomText(engine, sourceId), backend).toContain('records canaryrename4061');
      const hash = await contentHash(engine, sourceId, SLUG);
      await restrictFolder(engine, sourceId);
      expect(await renamePageOntoSlug(engine, { sourceId, oldSlug: SLUG, newSlug: RESTRICTED, to: `${RESTRICTED}.md` }), backend).toBe('renamed');
      expect(await contentHash(engine, sourceId, RESTRICTED), backend).toBe(hash);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(1);
      const again = copyingChat();
      await run(engine, sourceId, again.chat);
      expect(again.prompts.length, backend).toBe(1);
      expect(await remoteAtomText(engine, sourceId), backend).not.toContain('records canaryrename4061');
      for (const atom of await liveAtoms(engine, sourceId)) expect(atom.source_slug, backend).toBe(RESTRICTED);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
    }
  }, 120_000);

  test('case 4 boundary: a rename that leaves the page world stays settled and makes no model call (#7462)', async () => {
    const { engine } = engines.find(e => e.backend === 'pglite') ?? engines[0]!;
    const sourceId = await fresh('rename-world', engine);
    await put(engine, sourceId, PROSE('canaryrename4061'));
    await run(engine, sourceId, copyingChat().chat);
    expect(await renamePageOntoSlug(engine, { sourceId, oldSlug: SLUG, newSlug: 'archive/launch-review', to: 'archive/launch-review.md' })).toBe('renamed');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
    const again = copyingChat();
    await run(engine, sourceId, again.chat);
    expect(again.prompts.length).toBe(0);
  }, 120_000);

  test('a renamed-origin retirement planned against a generation another writer replaced retires nothing and leaves the page offered', async () => {
    const { engine } = engines.find(e => e.backend === 'pglite') ?? engines[0]!;
    const sourceId = await fresh('rename-race', engine);
    await put(engine, sourceId, `${PROSE('canaryrename4061')}\n\n${renderFactsTable([fact(1, RETAINED)])}`);
    await run(engine, sourceId, copyingChat().chat);
    const old = await liveAtoms(engine, sourceId);
    expect(old.length).toBeGreaterThan(1);
    await renamePageOntoSlug(engine, { sourceId, oldSlug: SLUG, newSlug: 'notes/launch-review-renamed', to: 'notes/launch-review-renamed.md' });
    await put(engine, sourceId, `${PROSE('canaryrename4061')}\n\nOne more line.`, {}, 'notes/launch-review-renamed');
    // The run reads the old slug's generation, then another writer publishes the next one before the retirement does:
    // modelled by handing the run's read the generation before the live one.
    const live = Number((await engine.executeRaw<{ g: number }>(`SELECT generation AS g FROM derived_generations WHERE source_id=$1 AND kind='atom'
      AND owner_key=$2 AND state='live'`, [sourceId, atomOwnerKey({ kind: 'page', slug: SLUG })]))[0]!.g);
    expect(live).toBeGreaterThan(0);
    const target = engine as unknown as { executeRaw: (...args: unknown[]) => Promise<Array<Record<string, unknown>>> };
    const original = target.executeRaw;
    let raced = false;
    target.executeRaw = async function (this: unknown, ...args: unknown[]) {
      const rows = await original.apply(this, args);
      if (raced || !String(args[0]).includes("split_part(dg.input_pin, ':', 2) = $3::text")) return rows;
      raced = true;
      return rows.map(r => ('generation' in r ? { ...r, generation: live - 1 } : r));
    };
    try {
      await run(engine, sourceId, copyingChat().chat);
    } finally { target.executeRaw = original; }
    expect(raced).toBe(true);
    expect((await liveAtoms(engine, sourceId)).filter(a => a.source_slug === SLUG).length).toBe(old.length);
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
    await run(engine, sourceId, copyingChat().chat);
    expect((await liveAtoms(engine, sourceId)).filter(a => a.source_slug === SLUG)).toEqual([]);
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
  }, 120_000);

  test('case 6 (recorded decision): approving a held world-fence row leaves the page settled until its next edit', async () => {
    // Re-offering on approval needs a record of which rows a scan omitted; facts rows carry no change time and this
    // lane adds no schema. The row is under-extracted, never exposed: the next edit of the page extracts it.
    const { engine } = engines.find(e => e.backend === 'pglite') ?? engines[0]!;
    const sourceId = await fresh('held-approve', engine);
    const held = 'Alice-example keeps bees canaryheld4061';
    const body = `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, held), fact(2, RETAINED)])}`;
    await put(engine, sourceId, body);
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num)
      VALUES ($1, 'people/alice-example', $2, 'fact', 'private', 'test', $3, 1)`, [sourceId, held, SLUG]);
    const first = copyingChat();
    await run(engine, sourceId, first.chat);
    expect(first.prompts[0]).not.toContain('canaryheld4061');
    await engine.executeRaw(`UPDATE facts SET visibility='world' WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=1`, [sourceId, SLUG]);
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
    await put(engine, sourceId, `${body}\n\nOne more line.`);
    const edited = copyingChat();
    await run(engine, sourceId, edited.chat);
    expect(edited.prompts[0]).toContain('canaryheld4061');
  }, 120_000);
});

describe('GST-4061 managed extract_atoms after withdrawals and renames', () => {
  let engine: PGLiteEngine;
  let home: string;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    home = mkdtempSync(join(tmpdir(), 'gbrain-gst4061-'));
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Every page is written before the brain is managed; later writes go through `unmanaged`.
    const pages = [`${PROSE('the launch')}\n\n${renderFactsTable([fact(1, WITHDRAWN), fact(2, RETAINED)])}`,
      `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, WITHDRAWN)])}`, PROSE('canaryrename4061'),
      `${PROSE('the launch')}\n\n${renderFactsTable([fact(1, WITHDRAWN), fact(2, RETAINED)])}`];
    for (const [i, body] of pages.entries()) {
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [`gst4061-managed-${i + 1}`]);
      await put(engine, `gst4061-managed-${i + 1}`, body);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    resetGateway();
    rmSync(home, { recursive: true, force: true });
  });
  const managed = async (index: number, body: (sourceId: string) => Promise<void>) => {
    const sourceId = `gst4061-managed-${index}`;
    try { await withEnv({ GBRAIN_HOME: home }, () => body(sourceId)); }
    finally { await disposePersistenceConsumer(engine); }
  };
  /** A write the test makes as the brain's sync would, outside the persistence coordinator. */
  const unmanaged = async (write: () => Promise<unknown>) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { return await write(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  };
  const managedAtoms = (sourceId: string) => engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL AND frontmatter->>'managed_extraction'='true'`, [sourceId]);

  test('case 2: a world withdrawal offers a managed page again and the rescan drops the withdrawn claim', () => managed(1, async sourceId => {
    const chat = copyingChat();
    expect((await run(engine, sourceId, chat.chat)).status).toBe('ok');
    expect(Number((await managedAtoms(sourceId))[0]!.n)).toBeGreaterThan(0);
    expect(await atomText(engine, sourceId)).toContain('canarywithdrawn4061');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
    await withdraw(engine, sourceId, WITHDRAWN);
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
    await run(engine, sourceId, chat.chat);
    expect(chat.prompts.length).toBe(2);
    expect(chat.prompts[1]).not.toContain('canarywithdrawn4061');
    const text = await atomText(engine, sourceId);
    expect(text).not.toContain('canarywithdrawn4061');
    expect(text).toContain('canaryretained4061');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
  }), 120_000);

  test('case 2 race: a world withdrawal recorded during the managed model call still offers the page again', () => managed(4, async sourceId => {
    const inner = copyingChat();
    let first = true;
    const chat = async (opts: ChatOpts) => {
      if (first) { first = false; await withdraw(engine, sourceId, WITHDRAWN); }
      return inner.chat(opts);
    };
    await run(engine, sourceId, chat);
    expect(inner.prompts[0]).toContain('canarywithdrawn4061');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
    await run(engine, sourceId, inner.chat);
    expect(inner.prompts.length).toBe(2);
    expect(await atomText(engine, sourceId)).not.toContain('canarywithdrawn4061');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
  }), 120_000);

  test('case 1 managed: an empty managed rescan after a withdrawal retires the atom quoting the withdrawn claim', () => managed(2, async sourceId => {
    await run(engine, sourceId, copyingChat().chat);
    expect(await atomText(engine, sourceId)).toContain('canarywithdrawn4061');
    await withdraw(engine, sourceId, WITHDRAWN);
    await run(engine, sourceId, copyingChat(true).chat);
    const text = await atomText(engine, sourceId);
    expect(text).not.toContain('canarywithdrawn4061');
    expect(text).toContain('Measure every launch');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
  }), 120_000);

  test('case 5: a managed page renamed into a restricted folder retires its old-slug atoms through the managed writer', () => managed(3, async sourceId => {
    await run(engine, sourceId, copyingChat().chat);
    expect(Number((await managedAtoms(sourceId))[0]!.n)).toBeGreaterThan(0);
    expect(await remoteAtomText(engine, sourceId)).toContain('records canaryrename4061');
    await unmanaged(() => restrictFolder(engine, sourceId));
    expect(await unmanaged(() => renamePageOntoSlug(engine, { sourceId, oldSlug: SLUG, newSlug: RESTRICTED, to: `${RESTRICTED}.md` }))).toBe('renamed');
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(1);
    const again = copyingChat();
    await run(engine, sourceId, again.chat);
    expect(again.prompts.length).toBe(1);
    expect(await remoteAtomText(engine, sourceId)).not.toContain('records canaryrename4061');
    for (const atom of await liveAtoms(engine, sourceId)) expect(atom.source_slug).toBe(RESTRICTED);
    expect(await countExtractAtomsBacklog(engine, sourceId)).toBe(0);
  }), 120_000);
});
