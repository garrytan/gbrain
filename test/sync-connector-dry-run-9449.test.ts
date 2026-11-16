/**
 * #9449: `gbrain sync --source <id> --dry-run` on a connector source of an unmanaged brain fetched from the provider and
 * wrote what it fetched (pages, chunks, soft-deletes); only the cursor was left alone. Every connector kind the sync
 * command dispatches to now says it has no preview and returns before any provider call or write.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { CONNECTOR_SOURCE_KINDS } from '../src/core/persistence/connector-kinds.ts';
import { contact, createConnectorFixture, githubConfig, githubFetch, googleConfig, json, withGoogleAccount } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const configs: Record<string, Record<string, unknown>> = {
  google: googleConfig,
  github: githubConfig,
  meetings: { kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false },
  slack: { kind: 'slack', s_channels: 'CGENERAL01' },
};
const googleContacts = withGoogleAccount(async () => json({ connections: [contact('first', 'First Example')], nextSyncToken: 'contacts-1' }));
const providers: Record<string, (url: string, init?: RequestInit) => Promise<Response>> = {
  google: googleContacts,
  github: githubFetch(),
  meetings: async () => json({ data: {} }),
  slack: async () => json({ ok: true, messages: [] }),
};

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name)).sort();
}

async function state(engine: BrainEngine, sourceId: string, dir: string) {
  const q = <T>(sql: string, params: unknown[] = []) => engine.executeRaw<T>(sql, params);
  return {
    pages: await q("SELECT slug, deleted_at::text AS deleted_at, content_hash FROM pages WHERE source_id=$1 ORDER BY slug", [sourceId]),
    chunks: await q('SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1', [sourceId]),
    source: await q('SELECT last_sync_at::text AS last_sync_at, config::text AS config FROM sources WHERE id=$1', [sourceId]),
    checkpoints: await q('SELECT op, fingerprint, completed_keys::text AS keys FROM op_checkpoints ORDER BY op, fingerprint'),
    config: await q('SELECT key, value FROM config ORDER BY key'),
    requests: await q('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [sourceId]),
    files: files(dir),
  };
}

// Value: protects=a connector dry run on an unmanaged brain fetches nothing and writes nothing (#9449);
// fails_when=runGoogleSync or runGitHubSync (or a new connector kind) sweeps the provider on --dry-run;
// why_new=the managed refusal test covers only managed brains, and the meetings and slack guards had no sync-command test;
// seam=performSync({ sourceId, dryRun }) with the provider stubbed at fetch; no_claim=a per-item preview (connectors have none).
test('a dry run of every connector kind on an unmanaged brain calls no provider and writes nothing', async () => withEnv(env, async () => {
  expect(Object.keys(configs).sort()).toEqual([...CONNECTOR_SOURCE_KINDS].sort());
  for (const engine of engines) for (const kind of CONNECTOR_SOURCE_KINDS) {
    const f = await source(engine, configs[kind]!);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return providers[kind]!(url, init);
    }) as unknown as typeof fetch;
    const before = await state(engine, f.id, f.dir);
    const result = await performSync(engine, { sourceId: f.id, dryRun: true, noExtract: true, noSchemaPack: true });
    globalThis.fetch = realFetch;
    expect({ engine: engine.kind, kind, status: result.status, added: result.added, modified: result.modified, deleted: result.deleted, chunks: result.chunksCreated, embedded: result.embedded })
      .toEqual({ engine: engine.kind, kind, status: 'dry_run', added: 0, modified: 0, deleted: 0, chunks: 0, embedded: 0 });
    expect({ kind, calls }).toEqual({ kind, calls: [] });
    expect(await state(engine, f.id, f.dir)).toEqual(before);
  }
}), 120_000);

// Value: protects=a managed brain refuses a connector dry run before any provider call or write, for every kind;
// fails_when=a connector kind skips beginConnectorSync's dry-run refusal on the sync command's managed route;
// why_new=the existing refusal test calls runGoogleSync and runGitHubSync directly, not the sync command, and skips
// meetings and slack; seam=performSync({ sourceId, dryRun }) on persistence_brain.enabled=true.
test('a dry run of every connector kind on a managed brain is refused before any provider call or write', async () => withEnv(env, async () => {
  for (const engine of engines) for (const kind of CONNECTOR_SOURCE_KINDS) {
    const f = await source(engine, configs[kind]!);
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      throw new Error('Unexpected external request');
    }) as unknown as typeof fetch;
    const before = await state(engine, f.id, f.dir);
    await expect(performSync(engine, { sourceId: f.id, dryRun: true, noExtract: true, noSchemaPack: true })).rejects.toMatchObject({ code: 'invalid_params' });
    globalThis.fetch = realFetch;
    expect({ kind, calls }).toEqual({ kind, calls: [] });
    expect(await state(engine, f.id, f.dir)).toEqual(before);
  }
}), 120_000);

