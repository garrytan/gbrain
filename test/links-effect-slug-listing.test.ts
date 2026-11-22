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
import { withEnv } from './helpers/with-env.ts';

const config = { engine: 'pglite' as const, embedding_disabled: true };
const SOURCE = 'slugcache';
const CLIENT = 'client-slugcache';
let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-slugcache-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [SOURCE]);
  for (let i = 0; i < 50; i++) {
    await engine.putPage(`people/seed-${i}`, { type: 'person', title: `seed ${i}`, compiled_truth: 'seed.', timeline: '', frontmatter: {} }, { sourceId: SOURCE });
  }
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES($1,'fixture-hash','slugcache-client','read write',$2)`, [CLIENT, SOURCE]);
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


describe('links effect slug listing', () => {
  test('ten same-source page effects list the source slugs at most once', async () => {
    let listings = 0;
    const original = engine.getAllSlugs.bind(engine);
    engine.getAllSlugs = (async (...args: Parameters<typeof original>) => { listings++; return original(...args); }) as typeof engine.getAllSlugs;
    try {
      for (let i = 0; i < 10; i++) await remoteWrite(`notes/page-${i}`, `---\ntype: note\ntitle: P${i}\n---\n\nSee [[custom/no-such-page]].\n`);
      listings = 0;
      await drainEffects();
    } finally {
      engine.getAllSlugs = original;
    }
    const [done] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_effects WHERE state='queued'");
    expect(done!.n).toBe(0);
    expect(listings).toBeLessThanOrEqual(1);
  }, 120_000);
});
