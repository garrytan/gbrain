/**
 * C5 (cost wave): search skips the saved-facts scan and the declared-name
 * scan cheaply when there is nothing to find, and changes nothing when there
 * is. The golden below was captured on the build before C5 (the cost wave's
 * C3+C4 commit) with GBRAIN_TEST_UPDATE_GOLDENS=1; it holds the full MCP
 * result (content[0], every notice block and _meta.retrieval) for searches
 * and queries on a brain with active saved facts and declared other names,
 * including one that fans out to the other name, plus the same searches on a
 * brain with neither. Regenerate only on a build whose search output is meant
 * to change, and say why in the commit. The query facts arm
 * (`search.query_facts_arm`, default on) changes query output on purpose, so
 * these brains pin it off; test/search-facts-arm.test.ts covers it.
 *
 * Also: a fact saved with `remember` is found by the next search in the same
 * process, and by a search after another process saved it (no per-process
 * cache can hide a fresh fact).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { aliasDeclarations } from '../src/core/ops/search.ts';
import { withEnv } from './helpers/with-env.ts';

const GOLDEN = join(import.meta.dir, 'fixtures/goldens/search-c5/notices.json');
const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };

const PAGES: Array<[string, string, string]> = [
  ['crm/numbat-labs', 'CRM record: Numbat Labs', 'Account record. Account code: NULA. Segment: mid-market. Billing contact: Old Person.'],
  ['contracts/numbat-labs-msa', 'MSA: Numbat Labs', 'Master services agreement with Numbat Labs (account code NULA). Payment terms: Net 45.'],
  ['contracts/amendment-one', 'Amendment No. 1: NULA', 'Executed amendment for NULA: payment terms change to Net 30.'],
  ['crm/ocelot-freight', 'CRM record: Ocelot Freight', 'Account record for Ocelot Freight, also known as OCFR. Renewal owner: the platform team.'],
  ['notes/renewal-playbook', 'Renewal playbook', 'Confirm the billing contact, check payment terms, send the renewal quote 60 days before the term ends.'],
];
const FACTS = `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES
  ('default', 'numbat-labs', 'The billing contact for Numbat Labs is New Person.', 'fact', 'world', 'user update', '2026-09-01'),
  ('default', 'ocelot-freight', 'Ocelot Freight renewal moves to the platform team.', 'fact', 'world', 'user update', '2026-09-02'),
  ('default', 'numbat-labs', 'Numbat Labs payment terms are disputed.', 'fact', 'private', 'user update', '2026-09-03')`;
const CALLS: Array<[string, Record<string, unknown>]> = [
  ['search', { query: 'NULA billing contact' }],
  ['search', { query: 'Numbat Labs payment terms' }],
  ['search', { query: 'OCFR renewal' }],
  ['search', { query: 'renewal quote' }],
  ['query', { query: 'Numbat Labs payment terms', expand: false }],
  ['query', { query: 'OCFR renewal owner', expand: false }],
];

/** Opens an engine; assigned in beforeAll (the canonical PGLite lifecycle, test/helpers/reset-pglite.ts). */
let open: (dataDir?: string) => Promise<PGLiteEngine>;

async function brain(withFactsAndNames: boolean): Promise<PGLiteEngine> {
  const engine = await open();
  for (const [slug, title, body] of PAGES) {
    const text = withFactsAndNames ? body : body.replace(/\(?account code NULA\)?|Account code: NULA\.|, also known as OCFR/g, '');
    await importFromContent(engine, slug, serializeMarkdown({}, text, '', { type: 'note', title, tags: [] }), { noEmbed: true, forceRechunk: true });
  }
  if (withFactsAndNames) await engine.executeRaw(FACTS);
  await engine.setConfig('search.query_facts_arm', 'false');
  return engine;
}

async function capture(engine: PGLiteEngine): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, args] of CALLS) {
    const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name, args, REMOTE));
    out[`${name} ${args.query}`] = { content: res.content.map(c => c.text), retrieval: res._meta?.retrieval };
  }
  return out;
}

/** Dates the importer stamps from today are the only run-to-run variance. */
const stable = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/\d{4}-\d{2}-\d{2}(?=\\?")/g, 'DATE'));

let withBoth: PGLiteEngine;
let withNeither: PGLiteEngine;
const opened: PGLiteEngine[] = [];
beforeAll(async () => {
  open = async (dataDir?: string) => {
    const engine = new PGLiteEngine();
    await engine.connect(dataDir ? { database_path: dataDir } : {});
    await engine.initSchema();
    opened.push(engine);
    return engine;
  };
  withBoth = await brain(true);
  withNeither = await brain(false);
}, 180_000);
afterAll(async () => { for (const engine of opened) await engine.disconnect().catch(() => {}); });

describe('byte-identical results before and after C5', () => {
  test('a brain with saved facts and declared names, and one with neither', async () => {
    const got = stable({ with: await capture(withBoth), without: await capture(withNeither) });
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
    }
    const want = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(got).toEqual(want);
    // The fixture exercises what C5 must not change: a saved fact, a declared
    // name in both directions, and a fan-out that splices a page in.
    const w = got.with as Record<string, { content: string[] }>;
    expect(w['search NULA billing contact'].content.join('\n')).toContain('New Person');
    expect(w['search NULA billing contact'].content.join('\n')).toContain('NULA = Numbat Labs');
    expect(w['search Numbat Labs payment terms'].content[0]).toContain('contracts/amendment-one');
    expect(JSON.stringify(got.without)).not.toContain('Saved facts');
  });
});

describe('declaration keyword precheck', () => {
  test('a row without any declaration keyword yields nothing; one with a keyword still parses', () => {
    expect(aliasDeclarations([{ slug: 'x', title: 'Note: Thing', chunk_text: 'No other name here. THING-2 is a code.' }], 'Thing')).toEqual([]);
    for (const label of ['Account code:', 'also known as', 'aka', 'Short name:', 'Ticker:', 'Code name:', 'TICKER']) {
      expect(aliasDeclarations([{ slug: 'x', title: 'Co: Widget Co', chunk_text: `Widget Co ${label} WDGT` }], 'Widget Co pricing'), label)
        .toEqual([{ name: 'Widget Co', alias: 'WDGT', slug: 'x' }]);
    }
  });
});

describe('a fresh fact is never hidden', () => {
  test('remember then search in the same process', async () => {
    const engine = await brain(false);
    try {
      const before = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'Numbat Labs escalation owner' }, REMOTE));
      expect(before.content.map(c => c.text).join('\n')).not.toContain('Saved facts');
      const saved = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'remember',
        { fact: 'The Numbat Labs escalation owner is Alice Example.', provenance: 'test', entity: 'numbat-labs' }, { ...REMOTE, writeWaitMs: 30_000 }));
      expect(saved.isError, saved.content[0].text).not.toBe(true);
      const after = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'Numbat Labs escalation owner' }, REMOTE));
      expect(after.content.map(c => c.text).join('\n')).toContain('escalation owner is Alice Example');
    } finally {
      await engine.disconnect();
    }
  }, 60_000);

  test('a fact saved by another process is found by the next search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-c5-'));
    const dataDir = join(dir, 'brain.pglite');
    try {
      let engine = await open(dataDir);
      await importFromContent(engine, 'crm/numbat-labs', serializeMarkdown({}, 'Account record for Numbat Labs.', '', { type: 'note', title: 'CRM record: Numbat Labs', tags: [] }), { noEmbed: true, forceRechunk: true });
      const before = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'Numbat Labs escalation owner' }, REMOTE));
      expect(before.content.map(c => c.text).join('\n')).not.toContain('Saved facts');
      await engine.disconnect();
      const child = spawnSync('bun', ['-e', `
        const engines = await import(${JSON.stringify(join(import.meta.dir, '../src/core/pglite-engine.ts'))});
        const e = new engines.PGLiteEngine();
        await e.connect({ database_path: ${JSON.stringify(dataDir)} });
        await e.executeRaw("INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES ('default', 'numbat-labs', 'The Numbat Labs escalation owner is Alice Example.', 'fact', 'world', 'other process')");
        await e.disconnect();`], { encoding: 'utf8', env: { ...process.env, GBRAIN_HOME: dir } });
      expect(child.status, child.stderr).toBe(0);
      engine = await open(dataDir);
      const after = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'search', { query: 'Numbat Labs escalation owner' }, REMOTE));
      expect(after.content.map(c => c.text).join('\n')).toContain('escalation owner is Alice Example');
      await engine.disconnect();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
