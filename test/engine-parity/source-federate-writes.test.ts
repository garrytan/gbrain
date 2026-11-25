/**
 * BrainEngine parity: `gbrain sources federate`, `unfederate`, `rename`, `webhook` and `tracked-branch`, the source
 * config and name writes src/commands/sources.ts sent through `executeRaw` (gbrain-evals bb9-006 and bb9-008).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), `unfederate` then
 *    `federate` flips `config.federated` under the source row lock, prints the same `--json` answer, and leaves every
 *    other config key alone; `sources list --json` prints the same bytes after each step; `rename` sets the display
 *    name; `webhook set/clear` and `tracked-branch --set` write the config the same way; an unknown id exits 4 with
 *    nothing written.
 *  - Regression: the commands read `config ... FOR UPDATE` and wrote `UPDATE sources` through `executeRaw`, which a
 *    Rust brain refuses (engine_capability_missing), so no source could be federated, unfederated, renamed or given a
 *    webhook there.
 *  - Why existing coverage misses it: test/sources-federate.test.ts and its neighbours run on PGLite only.
 *  - Seam: `process.exit` is stubbed to record the exit code, and console output is captured. Real engines otherwise.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { withWriteAttribution } from '../../src/core/persistence/attribution.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `gbrain sources <args>`; returns the exit code it asked for (or null) and what it printed to stdout. */
async function cli(engine: BrainEngine, args: string[]): Promise<{ exit: number | null; out: string; err?: string }> {
  const exit = process.exit;
  const { log, error, warn } = console;
  let code: number | null = null;
  const out: string[] = [];
  const err: string[] = [];
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    code = n;
    throw new Error(`exit ${n}`);
  }) as never;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')); };
  console.warn = () => {};
  try {
    await runSources(engine, args);
  } catch (e) {
    if (code === null) throw e;
  } finally {
    process.exit = exit;
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
  return { exit: code, out: out.join('\n'), ...(err.length ? { err: err.join('\n') } : {}) };
}

/** `sources list --json` with the per-run fields (creation and sync times) taken out, so the bytes compare. */
async function listed(engine: BrainEngine): Promise<string> {
  const { out } = await cli(engine, ['list', '--json']);
  return JSON.stringify(JSON.parse(out), (key, value) => (/(_at|_time)$/.test(key) ? undefined : value));
}

describe('engine parity: source federation and admin writes', () => {
  parityTest('sources unfederate then federate flip config.federated, print the same answer, and keep the rest of the config', {
    methods: ['lockSourceRow', 'replaceSourceConfig', 'getSource'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki', { federated: true, keep_me: 'yes' }, '/srv/brain/wiki');
    const config = async () => {
      const c = (await engine.getSource('wiki'))?.config as Record<string, unknown> | undefined;
      return { federated: c?.federated ?? null, keep_me: c?.keep_me ?? null };
    };
    const steps: Record<string, unknown> = {};
    steps.before = { list: await listed(engine) };
    steps.unfederate = { ...(await cli(engine, ['unfederate', 'wiki', '--json'])), config: await config(), list: await listed(engine) };
    steps.federate = { ...(await cli(engine, ['federate', 'wiki', '--json'])), config: await config(), list: await listed(engine) };
    steps.missing = await cli(engine, ['unfederate', 'no-such-source', '--json']);
    expect(steps).toMatchObject({
      unfederate: { exit: null, config: { federated: false, keep_me: 'yes' } },
      federate: { exit: null, config: { federated: true, keep_me: 'yes' } },
      missing: { exit: 4 },
    });
    expect(JSON.parse((steps.unfederate as { out: string }).out.split('\n').at(-1)!)).toMatchObject({ id: 'wiki', federated: false });
    expect(JSON.parse((steps.federate as { out: string }).out.split('\n').at(-1)!)).toMatchObject({ id: 'wiki', federated: true });
    return steps;
  });

  parityTest('sources federate from isolated and sources restore print the same warning for remote-written pages that name no readers', {
    methods: ['readFederationExposedPages', 'listOauthClients', 'listAccessTokens', 'insertOauthClient', 'replaceSourceConfig', 'createVersion'],
    timeout: 90_000,
  }, async (engine, backend) => {
    __resetPrivateVisibilityCacheForTests();
    await createSource(engine, backend, 'feed', { federated: false }, '/srv/brain/feed');
    await engine.insertOauthClient({ client_id: 'client-a', client_name: 'Client A', scope: 'read write', source_id: 'feed', member_id: 'alice-example' } as never);
    const page = (title: string, frontmatter: Record<string, unknown> = {}) =>
      ({ type: 'note' as never, title, compiled_truth: `${title} body.`, timeline: '', frontmatter });
    const asClient = (fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx =>
      withWriteAttribution(tx, { requestId: null, principal: { kind: 'oauth_client', id: 'client-a' } } as never, () => fn(tx)));
    // Remote-written pages: two that name no readers (one is private, so the privacy part hides it), one with readers.
    await asClient(tx => tx.putPage('notes/remote-one', page('Remote one'), { sourceId: 'feed' }));
    await asClient(tx => tx.putPage('notes/remote-private', page('Remote private', { visibility: 'private' }), { sourceId: 'feed' }));
    await asClient(tx => tx.putPage('notes/remote-readers', page('Remote readers', { readable_by: ['member:alice-example'] }), { sourceId: 'feed' }));
    // A local write after a remote one still counts, through the archived version the remote revision left.
    await asClient(tx => tx.putPage('notes/remote-then-local', page('Remote first'), { sourceId: 'feed' }));
    await engine.createVersion('notes/remote-then-local', { sourceId: 'feed' } as never);
    await engine.putPage('notes/remote-then-local', page('Local second'), { sourceId: 'feed' });
    await engine.putPage('notes/local-only', page('Local only'), { sourceId: 'feed' });
    const steps: Record<string, unknown> = {};
    steps.federate = await cli(engine, ['federate', 'feed', '--json']);
    steps.unfederate = await cli(engine, ['unfederate', 'feed', '--json']);
    steps.archive = (await cli(engine, ['archive', 'feed', '--yes'])).exit;
    steps.restore = await cli(engine, ['restore', 'feed']);
    const federated = JSON.parse((steps.federate as { out: string }).out.split('\n').at(-1)!);
    expect(federated.pages_exposed).toMatchObject({ count: 2, examples: [{ slug: 'notes/remote-one', member: 'alice-example' }, { slug: 'notes/remote-then-local', member: 'alice-example' }] });
    expect((steps.restore as { err?: string }).err ?? '').toContain('notes/remote-one');
    return steps;
  });

  parityTest('sources rename, webhook set and clear, and tracked-branch --set write the name and config the same way', {
    methods: ['renameSource', 'replaceSourceConfig', 'getSource'],
    timeout: 60_000,
  }, async (engine, backend) => {
    await createSource(engine, backend, 'repo', { federated: false }, '/srv/brain/repo');
    const read = async () => {
      const s = await engine.getSource('repo');
      const c = (s?.config ?? {}) as Record<string, unknown>;
      return { name: s?.name ?? null, webhook: typeof c.webhook_secret === 'string' ? 'set' : null, github_repo: c.github_repo ?? null, tracked_branch: c.tracked_branch ?? null };
    };
    const steps: Record<string, unknown> = {};
    steps.rename = { exit: (await cli(engine, ['rename', 'repo', 'Repo Display'])).exit, read: await read() };
    steps.webhook = { exit: (await cli(engine, ['webhook', 'set', 'repo', '--github-repo', 'acme-example/widget'])).exit, read: await read() };
    steps.branch = { exit: (await cli(engine, ['tracked-branch', 'repo', '--set', 'main'])).exit, read: await read() };
    steps.cleared = { exit: (await cli(engine, ['webhook', 'clear', 'repo'])).exit, read: await read(), list: await listed(engine) };
    steps.renameMissing = (await cli(engine, ['rename', 'no-such-source', 'X'])).exit;
    expect(steps).toEqual({
      rename: { exit: null, read: { name: 'Repo Display', webhook: null, github_repo: null, tracked_branch: null } },
      webhook: { exit: null, read: { name: 'Repo Display', webhook: 'set', github_repo: 'acme-example/widget', tracked_branch: null } },
      branch: { exit: null, read: { name: 'Repo Display', webhook: 'set', github_repo: 'acme-example/widget', tracked_branch: 'main' } },
      cleared: { exit: null, read: { name: 'Repo Display', webhook: null, github_repo: null, tracked_branch: 'main' }, list: steps.cleared && (steps.cleared as { list: string }).list },
      renameMissing: 4,
    });
    return steps;
  });
});
