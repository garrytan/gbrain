import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { discoverExtractablePages, countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { matchingLegacyAtomPageState, transferLegacyAtomPageState } from '../src/core/cycle/extract-atoms-page-state.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const body = 'Evidence about a synthetic example and its repeatable outcomes. '.repeat(20);
const slug = 'meetings/example';
const response = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const atoms = JSON.stringify([
  { title: 'First synthetic atom', atom_type: 'insight', body: 'First evidence.' },
  { title: 'Second synthetic atom', atom_type: 'insight', body: 'Second evidence.' },
]);
async function seed(sourceId = 'default') {
  await engine.putPage(slug, { type: 'meeting', title: 'Example', compiled_truth: body, timeline: '', frontmatter: { custom: { keep: true } } }, { sourceId });
}
async function rows() {
  return engine.executeRaw<{ page_id: number; content_hash: string; fail_count: number; tombstoned: boolean }>('SELECT * FROM extract_atoms_page_state');
}
async function snapshot() {
  return (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
}
async function scan(text: string) {
  return runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => response(text) });
}

describe('derived atom page state', () => {
  test('zero-yield bookkeeping never changes canonical frontmatter, revision, hash, or versions', async () => {
    await seed();
    const before = await snapshot();
    const versions = await engine.executeRaw('SELECT * FROM page_versions');
    expect((await scan('[]')).status).toBe('ok');
    expect(await snapshot()).toEqual(before);
    expect(await engine.executeRaw('SELECT * FROM page_versions')).toEqual(versions);
    expect(await rows()).toEqual([expect.objectContaining({ page_id: before.page.id, content_hash: before.page.content_hash, fail_count: 0, tombstoned: true })]);
    expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
  });

  test('malformed output counts to three without canonical mutation; transient failures do not count', async () => {
    await seed();
    const before = await snapshot();
    await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { throw new Error('503 timeout'); } });
    expect(await rows()).toEqual([]);
    for (let count = 1; count <= 3; count++) {
      const result = await scan('not an array');
      expect(result.status).toBe('warn');
      expect(await rows()).toEqual([expect.objectContaining({ fail_count: count, tombstoned: count === 3 })]);
      expect(await snapshot()).toEqual(before);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(count === 3 ? 0 : 1);
    }
  });

  test('edited, soft-deleted, and physically recreated pages never inherit a tombstone', async () => {
    await seed();
    await scan('[]');
    await engine.putPage(slug, { ...(await snapshot()).page, content_hash: undefined, compiled_truth: body + 'Edited.' }, { sourceId: 'default' });
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    await scan('[]');
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE slug=$1', [slug]);
    expect(await rows()).toEqual([]);
    await engine.executeRaw('UPDATE pages SET deleted_at=NULL WHERE slug=$1', [slug]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    await scan('[]');
    const oldId = (await snapshot()).page.id;
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
    await seed();
    expect((await snapshot()).page.id).not.toBe(oldId);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
  });

  test('source recreation and same-slug pages in another source never inherit state', async () => {
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('example','Example')");
    await seed('example');
    await runPhaseExtractAtoms(engine, { sourceId: 'example', _transcripts: [], _chat: async () => response('[]') });
    await seed();
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    await engine.executeRaw("DELETE FROM sources WHERE id='example'");
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('example','Example')");
    await seed('example');
    expect(await countExtractAtomsBacklog(engine, 'example')).toBe(1);
  });

  test.each(['[]', atoms])('a page edited during the provider call cannot complete stale extraction: %s', async text => {
    await seed();
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => {
      await engine.putPage(slug, { ...(await snapshot()).page, content_hash: undefined, compiled_truth: body + 'Concurrent edit.' }, { sourceId: 'default' });
      return response(text);
    } });
    expect(result.status).toBe('warn');
    expect(JSON.stringify(result.details.failures)).toContain('changed');
    expect(await rows()).toEqual([]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    const receipts = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom'");
    expect(receipts.every(row => row.hash.startsWith('pending:'))).toBe(true);
  });

  test.each(['[]', atoms])('a page recreated during the provider call cannot complete stale extraction: %s', async text => {
    await seed();
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => {
      await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
      await seed();
      return response(text);
    } });
    expect(result.status).toBe('warn');
    expect(await rows()).toEqual([]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    const receipts = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom'");
    expect(receipts.every(row => row.hash.startsWith('pending:'))).toBe(true);
  });

  test.each([
    ['42501', 'check database permissions'],
    ['42P01', 'check schema migrations'],
    ['private-code-sentinel', 'check database access'],
  ])('state write failures stay visible without private error payloads: %s', async (code, guidance) => {
    await seed();
    const execute = engine.executeRaw;
    const messages: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
    engine.executeRaw = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO extract_atoms_page_state')) throw Object.assign(new Error('private-payload-sentinel SQL parameter dump'), { code });
      return execute.call(engine, sql, params);
    }) as typeof execute;
    try {
      const result = await scan('[]');
      expect(result.status).toBe('warn');
      expect(JSON.stringify(result.details.failures)).toContain(guidance);
      expect(JSON.stringify(result.details.failures)).toContain('remains retryable');
      expect(JSON.stringify(result.details.failures)).not.toContain('private-payload-sentinel');
      expect(JSON.stringify(result.details.failures)).not.toContain('private-code-sentinel');
      expect(messages.join('\n')).not.toContain('private-payload-sentinel');
      expect(messages.join('\n')).not.toContain('private-code-sentinel');
      expect(messages.join('\n')).toContain(guidance);
    } finally { engine.executeRaw = execute; console.error = log; }
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
  });

  test('managed atom extraction refuses before any provider call, including dry runs', async () => {
    await seed();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let calls = 0;
    for (const dryRun of [false, true]) {
      await expect(runPhaseExtractAtoms(engine, { dryRun, _transcripts: [], _chat: async () => {
        calls++; return response(atoms);
      } })).rejects.toThrow('Atom extraction cannot mutate a managed brain');
    }
    expect(calls).toBe(0);
    expect(await rows()).toEqual([]);
  });

  test.each(['atom', 'links', 'deleted-before-completion'])('partial %s publication never finalizes source_hash or scan state', async failure => {
    await seed();
    const put = engine.putPage, links = engine.addLinksBatch;
    let writes = 0;
    engine.putPage = (async function (this: PGLiteEngine, ...args: Parameters<typeof put>) {
      if (failure === 'atom' && args[1].type === 'atom' && ++writes === 2) throw new Error('synthetic second atom failure');
      return put.apply(this, args);
    }) as typeof put;
    engine.addLinksBatch = async (...args) => {
      if (failure === 'links') throw new Error('synthetic provenance failure');
      const result = await links.apply(engine, args);
      if (failure === 'deleted-before-completion') {
        await engine.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug=$1", [args[0][0].to_slug]);
      }
      return result;
    };
    try {
      const result = await scan(atoms);
      expect(result.status).toBe('warn');
      if (failure === 'deleted-before-completion') {
        expect(JSON.stringify(result.details.failures)).toContain('pending atoms remain retryable');
      }
    }
    finally { engine.putPage = put; engine.addLinksBatch = links; }
    const pending = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom'");
    expect(pending).toHaveLength(failure === 'links' ? 2 : 1);
    expect(pending.every(row => row.hash.startsWith('pending:'))).toBe(true);
    expect((await rows()).every(row => !row.tombstoned)).toBe(true);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    expect((await scan(atoms)).status).toBe('ok');
    const complete = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom'");
    expect(complete).toHaveLength(2);
    expect(complete.every(row => row.hash === (pending[0].hash.slice('pending:'.length)))).toBe(true);
    expect((await engine.getLinks(slug)).filter(link => link.link_source === 'atom-provenance')).toHaveLength(2);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  });
});

describe('legacy atom state migration and reviewed cleanup', () => {
  test('migration copies only well-formed matching markers, preserving canonical data and revision', async () => {
    const hash = 'a'.repeat(64), stale = 'b'.repeat(16);
    const markers = [
      { atoms_scan_hash: hash.slice(0, 16) },
      { atoms_fail_hash: hash.slice(0, 16), atoms_fail_count: 2 },
      { atoms_scan_hash: stale },
      { atoms_fail_hash: hash.slice(0, 16), atoms_fail_count: '2' },
      { atoms_fail_hash: hash.slice(0, 16), atoms_fail_count: 1.5 },
      { atoms_scan_hash: hash.slice(0, 16), atoms_fail_hash: stale, atoms_fail_count: 3 },
      { atoms_scan_hash: hash.slice(0, 16), atoms_fail_count: 3 },
      { atoms_scan_hash: null },
      { atoms_fail_hash: hash.slice(0, 16), atoms_fail_count: 2147483648 },
    ];
    for (let i = 0; i < markers.length; i++) {
      await engine.putPage(`meetings/legacy-${i}`, { type: 'meeting', title: 'Legacy example', compiled_truth: body, frontmatter: markers[i] });
    }
    await engine.executeRaw('UPDATE pages SET content_hash=$1', [hash]);
    const before = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
    const migration = MIGRATIONS.find(m => m.name === 'derived_atom_page_scan_state')!;
    await engine.runMigration(migration.version, migration.sql);
    await engine.runMigration(migration.version, migration.sql);
    expect(await engine.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
    expect(await rows()).toHaveLength(2);
    expect((await rows()).map(row => [row.fail_count, row.tombstoned]).sort()).toEqual([[0, true], [2, false]]);
    for (let i = 0; i < markers.length; i++) expect(matchingLegacyAtomPageState(markers[i], hash) !== null).toBe(i < 2);
  });

  test('reviewed cleanup carries state to a changed hash only for identical canonical input', async () => {
    await seed();
    const hash = 'd'.repeat(64);
    await engine.executeRaw(`UPDATE pages SET frontmatter=frontmatter || jsonb_build_object(
      'atoms_scan_hash',$1::text,'atoms_fail_hash',$1::text,'atoms_fail_count',3), content_hash=$3 WHERE slug=$2`, [hash.slice(0, 16), slug, hash]);
    const before = await snapshot();
    const clean = { ...before.page.frontmatter };
    delete clean.atoms_scan_hash; delete clean.atoms_fail_hash; delete clean.atoms_fail_count;
    await engine.putPage(slug, { ...before.page, content_hash: undefined, frontmatter: clean });
    const after = await snapshot();
    expect(after.page.content_hash).not.toBe(before.page.content_hash);
    expect(await transferLegacyAtomPageState(engine, before, after)).toBe(true);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    await engine.executeRaw('DELETE FROM extract_atoms_page_state');
    await engine.putPage(slug, { ...after.page, content_hash: undefined, compiled_truth: body + 'Real edit.' });
    expect(await transferLegacyAtomPageState(engine, before, await snapshot())).toBe(false);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    expect(await transferLegacyAtomPageState(engine, before, after)).toBe(false);
  });
});
