/**
 * Engine parity for the first page write to a git-rooted source no writer claimed (bench N1/N5): each engine keeps its
 * own rule. A single-process engine (PGLite) claims the source and commits the page and its file; Postgres, a
 * multi-process engine, refuses `owner_unavailable` until `gbrain sources writer claim` (#6608); a Rust brain refuses
 * managed mode with the typed `managed_persistence` refusal.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a put_page to an unclaimed rooted source, from a trusted local caller and from a remote MCP caller on
 *    stdio and on http, commits the page and writes its file on PGLite, and refuses owner_unavailable with no
 *    page and no file on Postgres. On the Rust engine, which holds managed mode, the write refuses with the
 *    typed `managed_persistence` refusal before anything is claimed.
 *  - Regression: persistence/unbound-source.ts decideUnboundWrite auto-claimed only on PGLite, so the Rust engine
 *    refused owner_unavailable (unbound_source) where PGLite commits.
 *  - Why existing coverage misses it: test/persistence-*.test.ts run on PGLite and Postgres only; no parity case wrote
 *    to an unclaimed rooted source. Over MCP a refusal comes back inside the tool result, not as a thrown error, so
 *    the remote cases go through dispatchToolCall.
 *  - Seam: none. Real engines, the put_page handler and dispatchToolCall, a real Git checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';

const { parityTest } = parityArms(testBackends());

const SLUG = 'notes/bob-example';
const CONTENT = '---\ntitle: Bob Example\n---\nBob works at widget-co.\n';
const CAPABILITY = 'engine_capability_missing';

type Outcome = { ok: true; status: unknown } | { ok: false; code: string };

/**
 * A git checkout with no writer claimed, as the root of `sourceId`: a registered source (`sources add vault --path`),
 * or `default` through `sync.repo_path`. Runs `write`, then reads what it left.
 */
async function withUnclaimedCheckout(engine: BrainEngine, backend: ParityBackend, sourceId: string, write: () => Promise<Outcome>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-unbound-claim-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'vault');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      if (sourceId === 'default') await engine.setConfig('sync.repo_path', root);
      else await createSource(engine, backend, sourceId, {}, root);
      try {
        const put = await write();
        const page = await engine.getPage(SLUG, { sourceId });
        const file = join(root, 'notes', 'bob-example.md');
        const out = { put, page: page !== null, file: existsSync(file) && readFileSync(file, 'utf8').includes('widget-co') };
        // Postgres is multi-process: it never claims on a write. PGLite is a single-process engine and does; Rust refused above.
        expect(out).toEqual(backend === 'postgres'
          ? { put: { ok: false, code: 'owner_unavailable' }, page: false, file: false }
          : { put: { ok: true, status: 'created_or_updated' }, page: true, file: true });
        return { followedItsEngineRule: true };
      } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The handler as the local CLI calls it. A typed capability refusal is rethrown, so the Rust arm counts it. */
async function localPut(engine: BrainEngine, sourceId: string): Promise<Outcome> {
  const ctx = { engine, sourceId, remote: false as const, writeWaitMs: 8000, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  try {
    const r = await operations.find(o => o.name === 'put_page')!.handler(ctx as never, { slug: SLUG, content: CONTENT }) as Record<string, unknown>;
    return { ok: true, status: r.status ?? null };
  } catch (error) {
    const code = (error as { code?: string }).code ?? String(error);
    if (code === CAPABILITY) throw error;
    return { ok: false, code };
  }
}

/** The same write through the MCP dispatcher. Its refusal is in the tool result; a capability refusal is rethrown. */
async function remotePut(engine: BrainEngine, transport: 'stdio' | 'http', sourceId: string): Promise<Outcome> {
  const auth = transport === 'http'
    ? await (async () => {
      const minted = await mintLegacyToken(engine, { name: 'unbound-claim', scopes: ['read', 'write'], takesHolders: ['world'] });
      return { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] };
    })()
    : undefined;
  const result = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: CONTENT }, { remote: true, transport, sourceId,
    admissionOrigin: 'interactive', takesHoldersAllowList: ['world'], ...(auth ? { auth } : {}) } as never);
  const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  if (result.isError !== true) return { ok: true, status: body.status ?? null };
  const code = String(body.code ?? body.error);
  if (code === CAPABILITY) throw body;
  return { ok: false, code };
}

// A Rust brain refuses managed mode until the managed-persistence program is done (store-capabilities.ts holds
// `managed_persistence`): the first write to a rooted source would claim a managed worktree, so every case below ends on the
// typed managed_persistence refusal on the Rust arm, before anything is claimed or written, and compares equal on PGLite and
// Postgres. Each case reads the page back with getPage on every arm it runs.

describe('the first page write to a rooted source no writer claimed', () => {
  parityTest('a local put_page: PGLite claims and commits, Postgres refuses owner_unavailable, Rust refuses managed_persistence',
    { methods: ['getPage'], requires: 'managed_persistence', timeout: 60_000 },
    async (engine, backend) => withUnclaimedCheckout(engine, backend, 'vault', () => localPut(engine, 'vault')));

  parityTest('an MCP put_page over stdio follows the same rule',
    { methods: ['getPage'], requires: 'managed_persistence', timeout: 60_000 },
    async (engine, backend) => withUnclaimedCheckout(engine, backend, 'vault', () => remotePut(engine, 'stdio', 'vault')));

  parityTest('an MCP put_page over http follows the same rule',
    { methods: ['getPage'], requires: 'managed_persistence', timeout: 60_000 },
    async (engine, backend) => withUnclaimedCheckout(engine, backend, 'default', () => remotePut(engine, 'http', 'default')));
});
