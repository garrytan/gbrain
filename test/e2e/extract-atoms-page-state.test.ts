import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { withSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { readAtomPageIdentity, transferLegacyAtomPageState, writeAtomPageState } from '../../src/core/cycle/extract-atoms-page-state.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';

const describeDb = hasDatabase() ? describe : describe.skip;
describeDb('Postgres derived atom page state', () => {
  let engine: PostgresEngine;
  const slug = 'meetings/atom-state-example';
  const body = 'Synthetic evidence with sufficient source detail for extraction. '.repeat(20);
  const chat = async (): Promise<ChatResult> => ({ text: '[]', blocks: [{ type: 'text', text: '[]' }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
  beforeAll(async () => { engine = await setupDB(); }, 60000);
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('TRUNCATE pages CASCADE');
    await engine.executeRaw("DELETE FROM sources WHERE id='atom-state-example'");
    await engine.putPage(slug, { title: 'Synthetic example', type: 'meeting', compiled_truth: body, timeline: '', frontmatter: { preserve: { nested: true } } });
  });
  const snapshot = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;

  test('zero-yield scan is indexed derived state, never canonical page mutation', async () => {
    const before = await snapshot();
    expect((await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: chat })).status).toBe('ok');
    expect(await snapshot()).toEqual(before);
    expect(await discoverExtractablePages(engine, 'default')).toEqual([]);
    expect(await countExtractAtomsBacklog(engine)).toBe(0);
    expect(await engine.executeRaw('SELECT fail_count,tombstoned FROM extract_atoms_page_state'))
      .toEqual([{ fail_count: 0, tombstoned: true }]);
    const indexes = await engine.executeRaw<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='extract_atoms_page_state'");
    expect(indexes.map(row => row.indexname)).toContain('extract_atoms_page_state_tombstoned_idx');
  });

  test('CAS rejects stale content and page/source replacement', async () => {
    const before = await snapshot();
    const item = { slug, content: body, contentHash: before.page.content_hash! };
    const identity = await readAtomPageIdentity(engine, 'default', item);
    await engine.putPage(slug, { ...before.page, content_hash: undefined, compiled_truth: body + 'Edited.' });
    await expect(writeAtomPageState(engine, 'default', { ...item, identity }, 'complete')).rejects.toThrow('page changed');
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
    await engine.putPage(slug, { ...before.page });
    await expect(writeAtomPageState(engine, 'default', { ...item, identity }, 'complete')).rejects.toThrow('page changed');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('atom-state-example','Example')");
    await engine.putPage(slug, { ...before.page }, { sourceId: 'atom-state-example' });
    const sourceIdentity = await readAtomPageIdentity(engine, 'atom-state-example', item);
    await engine.executeRaw("DELETE FROM sources WHERE id='atom-state-example'");
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('atom-state-example','Replacement')");
    await engine.putPage(slug, { ...before.page }, { sourceId: 'atom-state-example' });
    await expect(writeAtomPageState(engine, 'atom-state-example', { ...item, identity: sourceIdentity }, 'complete')).rejects.toThrow('page changed');
  });

  test('a state write waiting behind a concurrent edit rechecks its CAS after the lock', async () => {
    const before = await snapshot();
    const item = { slug, content: body, contentHash: before.page.content_hash! };
    const identity = await readAtomPageIdentity(engine, 'default', item);
    let edited!: () => void, release!: () => void;
    const editReady = new Promise<void>(resolve => { edited = resolve; });
    const continueEdit = new Promise<void>(resolve => { release = resolve; });
    const writer = engine.transaction(async tx => {
      await tx.executeRaw('UPDATE pages SET compiled_truth=$1, content_hash=$2 WHERE slug=$3', [body + 'Changed.', 'e'.repeat(64), slug]);
      edited();
      await continueEdit;
    });
    await editReady;
    const stamp = writeAtomPageState(engine, 'default', { ...item, identity }, 'complete').then(() => null, error => error);
    let observedLock = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await engine.executeRaw<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%INSERT INTO extract_atoms_page_state%') AS waiting`);
        if (row.waiting) { observedLock = true; break; }
        await Bun.sleep(10);
      }
    } finally { release(); }
    await writer;
    expect(observedLock).toBe(true);
    expect((await stamp)?.message).toContain('page changed');
    expect(await engine.executeRaw('SELECT * FROM extract_atoms_page_state')).toEqual([]);
  });

  test('migration backfills matching valid markers only and never rewrites canonical pages', async () => {
    const hash = 'c'.repeat(64), scan = hash.slice(0, 16);
    await engine.executeRaw(`UPDATE pages SET content_hash=$1,
      frontmatter=frontmatter || jsonb_build_object('atoms_scan_hash',$2::text,'atoms_fail_hash',$2::text,'atoms_fail_count',3)
      WHERE slug=$3`, [hash, scan, slug]);
    await engine.putPage('meetings/stale-marker', { type: 'meeting', title: 'Stale marker', compiled_truth: body,
      content_hash: hash, frontmatter: { atoms_scan_hash: 'd'.repeat(16) } });
    await engine.putPage('meetings/invalid-marker', { type: 'meeting', title: 'Invalid marker', compiled_truth: body,
      content_hash: hash, frontmatter: { atoms_fail_hash: scan, atoms_fail_count: '3' } });
    const before = await engine.executeRaw('SELECT * FROM pages ORDER BY id');
    const migration = MIGRATIONS.find(m => m.name === 'derived_atom_page_scan_state')!;
    await engine.runMigration(migration.version, migration.sql);
    await engine.runMigration(migration.version, migration.sql);
    expect(await engine.executeRaw('SELECT * FROM pages ORDER BY id')).toEqual(before);
    expect(await engine.executeRaw('SELECT fail_count,tombstoned FROM extract_atoms_page_state'))
      .toEqual([{ fail_count: 3, tombstoned: true }]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
    const prior = await snapshot();
    await engine.putPage(slug, { ...prior.page, content_hash: undefined, frontmatter: { preserve: { nested: true } } });
    const next = await snapshot();
    expect(next.page.content_hash).not.toBe(prior.page.content_hash);
    expect(await transferLegacyAtomPageState(engine, prior, next)).toBe(true);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
  });

  test('managed refusal precedes all provider calls', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let calls = 0;
    await expect(withSubmissionAuthority({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'example-client' },
      grant: { scopes: ['admin'], sourceId: 'default', sourceCreatedAt: new Date().toISOString(), allowedTools: ['put_page'], allowedSlugPrefixes: ['*'] },
      payloadHash: '0'.repeat(64) }, () => runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { calls++; return chat(); } })))
      .rejects.toThrow('Atom extraction cannot mutate a managed brain');
    expect(calls).toBe(0);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  });

  test.each(['atom', 'links', 'deleted-before-completion'])('partial %s writes retain pending receipts until every atom and edge persists', async failure => {
    const put = engine.putPage, addLinks = engine.addLinksBatch;
    let writes = 0;
    engine.putPage = async function (...args) {
      if (failure === 'atom' && args[1].type === 'atom' && ++writes === 2) throw new Error('synthetic atom failure');
      return put.apply(this, args);
    };
    engine.addLinksBatch = async function (...args) {
      if (failure === 'links') throw new Error('synthetic link failure');
      const result = await addLinks.apply(this, args);
      if (failure === 'deleted-before-completion') {
        await this.executeRaw("DELETE FROM pages WHERE source_id='default' AND slug=$1", [args[0][0].to_slug]);
      }
      return result;
    };
    const atomChat = async (): Promise<ChatResult> => ({ ...await chat(), text: JSON.stringify([
      { title: 'First parity insight', atom_type: 'insight', body: 'Synthetic first evidence.' },
      { title: 'Second parity insight', atom_type: 'insight', body: 'Synthetic second evidence.' },
    ]) });
    try {
      const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: atomChat });
      expect(result.status).toBe('warn');
      if (failure === 'deleted-before-completion') {
        expect(JSON.stringify(result.details.failures)).toContain('pending atoms remain retryable');
      }
    } finally { engine.putPage = put; engine.addLinksBatch = addLinks; }
    const pending = await engine.executeRaw<{ hash: string }>("SELECT frontmatter->>'source_hash' AS hash FROM pages WHERE type='atom'");
    expect(pending).toHaveLength(failure === 'links' ? 2 : 1);
    expect(pending.every(row => row.hash.startsWith('pending:'))).toBe(true);
    expect(await engine.executeRaw('SELECT 1 FROM extract_atoms_page_state WHERE tombstoned')).toEqual([]);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    expect((await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: atomChat })).status).toBe('ok');
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    expect((await engine.getLinks(slug)).filter(link => link.link_source === 'atom-provenance')).toHaveLength(2);
  });
});
