/**
 * Graph freshness after a remote (OAuth) put_page, measured end to end on
 * PGLite: what is queryable at commit, what the post-commit `links` effect
 * adds, and what the extract phase adds. Report-only for P8: it pins the
 * order of arrival and prints the time to each stage.
 *
 *   at commit      the page and its dated timeline row; no links yet
 *   links effect   plain `mentions` edges to visible same-source pages
 *   extract phase  typed edges (works_at) from the prose; the untrusted
 *                  remote write never produces them before extract runs
 *
 * `mcp.remote_auto_links=false` leaves the effect off; extract still runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runCycle } from '../src/core/cycle.ts';
import { withEnv } from './helpers/with-env.ts';

const config = { engine: 'pglite' as const, embedding_disabled: true };
const SOURCE = 'freshness';
const CLIENT = 'client-freshness';
let engine: PGLiteEngine;
let home: string;

const BODY = `---
type: note
title: Freshness example
---

Met [[people/alice-example]] today. Alice works at [[companies/acme-example]] as head of research.

## Timeline

- **2026-09-14** | meeting — Alice joined [[companies/acme-example]].
`;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-freshness-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  for (const [slug, type] of [['people/alice-example', 'person'], ['companies/acme-example', 'company']] as const) {
    await engine.putPage(slug, { type, title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter: {} }, { sourceId: SOURCE });
  }
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','freshness-client','read write',$2)`, [CLIENT, SOURCE]);
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function remoteWrite(slug: string, content: string) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    await registerLocalWriter(engine, 'cli');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SOURCE]);
    const ctx: OperationContext = { engine, config, dryRun: false, remote: true, sourceId: SOURCE, logger: { info() {}, warn() {}, error() {} },
      auth: { token: 'fixture', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'], sourceId: SOURCE } as OperationContext['auth'] };
    const authority = await submissionAuthority(ctx, 'put_page', SOURCE, source!.incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: SOURCE, sourceIncarnation: source!.incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    const committed = await publishMutation(engine, row, await preparePageMutation(engine, row, config));
    expect(committed.state).toBe('committed');
    return committed;
  });
}

/** Run the effect worker until no effect is queued (each pass takes a bounded batch). */
async function drainEffects() {
  for (let i = 0; i < 10; i++) {
    await withEnv({ GBRAIN_HOME: home }, () => runPersistenceEffects(engine, config, { hostId: localHostId() }));
    const [q] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE state='queued'");
    if (!q || q.n === 0) return;
  }
}

const edges = (from: string) => engine.executeRaw<{ to_slug: string; link_type: string }>(`SELECT t.slug AS to_slug, l.link_type
  FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.slug, l.link_type`, [SOURCE, from]);
const timelineRows = (slug: string) => engine.executeRaw<{ date: string }>(`SELECT t.date::text AS date FROM timeline_entries t JOIN pages p ON p.id=t.page_id
  WHERE p.source_id=$1 AND p.slug=$2`, [SOURCE, slug]);

describe('remote put_page graph freshness', () => {
  test('commit, then mention links from the effect, then typed edges from extract', async () => {
    const t0 = Date.now();
    await remoteWrite('notes/freshness-example', BODY);
    const commitMs = Date.now() - t0;
    expect(await timelineRows('notes/freshness-example')).toEqual([{ date: '2026-09-14' }]);
    expect(await edges('notes/freshness-example')).toEqual([]);

    await drainEffects();
    const mentionMs = Date.now() - t0;
    const afterEffect = await edges('notes/freshness-example');
    expect(afterEffect.filter(e => e.link_type === 'mentions').map(e => e.to_slug)).toEqual(['companies/acme-example', 'people/alice-example']);
    expect(afterEffect.some(e => e.link_type === 'works_at')).toBe(false);

    await withEnv({ GBRAIN_HOME: home }, () => runCycle(engine, { brainDir: null, sourceId: SOURCE, phases: ['extract'] } as never));
    const typedMs = Date.now() - t0;
    const afterExtract = await edges('notes/freshness-example');
    console.log(`[remote-graph-freshness] commit=${commitMs}ms mention_links=${mentionMs}ms typed_edges=${typedMs}ms edges=${JSON.stringify(afterExtract)}`);
    expect(afterExtract.some(e => e.link_type === 'mentions' && e.to_slug === 'people/alice-example')).toBe(true);
    expect(afterExtract.some(e => e.link_type !== 'mentions')).toBe(true);
  }, 120_000);

  test('mcp.remote_auto_links=false queues no mention pass', async () => {
    await engine.setConfig('mcp.remote_auto_links', 'false');
    try {
      const row = await remoteWrite('notes/freshness-off', BODY.replace('Freshness example', 'Freshness off'));
      expect((row.outcome?.auto_links as Record<string, unknown> | undefined)?.mention_links).toBeUndefined();
      await drainEffects();
      expect((await edges('notes/freshness-off')).filter(e => e.link_type === 'mentions')).toEqual([]);
    } finally {
      await engine.unsetConfig('mcp.remote_auto_links');
    }
  }, 120_000);
});
