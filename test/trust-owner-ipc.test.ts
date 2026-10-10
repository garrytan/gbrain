/**
 * Owner trust actions while a resident owner holds the brain (#5575: DX-2,
 * ENG-15, CEO-2, CEO-9).
 *
 * Protects: `gbrain trust review|confirm|drop` reach the resident PGLite
 * owner over its 0600 administration socket (trust_read / trust_preview /
 * trust_apply) instead of failing on the lock; a non-TTY confirm through the
 * socket is refused with confirmation_required and changes nothing; the
 * typed-token prompt happens in the invoking CLI and the owner applies the
 * approval bound to the previewed revision; an MCP session of the same
 * process (stdio or HTTP) cannot reach the owner actions: the admin
 * operations are not tools, confirm_memory refuses connections without
 * memory_confirm, the operation lane of the socket does not carry them, and
 * the owner refuses them outside a verified local CLI registration.
 * Fails if any of those paths opens, or the CLI stops delegating.
 * PGLite only (the resident-owner socket is a PGLite topology).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { PERSISTENCE_IPC_OPERATIONS, startPersistenceIpcServer, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { PERSISTENCE_ADMIN_OPERATIONS } from '../src/core/persistence/admin-contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { withCoordinatedWrite, withTrustBackfill } from '../src/core/persistence/context.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setConfirmationIoForTests } from '../src/core/trust/confirm.ts';
import { getTrustProposal } from '../src/core/trust/proposals.ts';
import { TRUST_ADMIN_OPERATIONS, runTrustAdministration } from '../src/core/trust/owner-ipc.ts';
import { maybeDelegateTrust } from '../src/commands/trust.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const ENV = { GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
let dir: string;
let engine: PGLiteEngine;
let config: { engine: 'pglite'; database_path: string };
let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>>;
let agentCtx: OperationContext;
const quiet = { info() {}, warn() {}, error() {} };
const page = (body: string) => `---\ntype: note\ntitle: Owner\n---\n${body}\n`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-trust-ipc-'));
  config = { engine: 'pglite', database_path: join(dir, 'db') };
  await withEnv({ GBRAIN_HOME: dir, ...ENV }, async () => {
    engine = new PGLiteEngine();
    await engine.connect(config);
    await engine.initSchema();
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
    const minted = await mintLegacyToken(engine, { name: 'agent', scopes: ['read', 'write'], sourceGrant: ['default'], takesHolders: ['world'] });
    agentCtx = { engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId: 'default', dryRun: false, logger: quiet, remote: true, transport: 'http',
      takesHoldersAllowList: ['world'], auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write'] } } as unknown as OperationContext;
    const provider = await createPersistenceIpcProvider(engine, config);
    await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
    binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider);
  });
}, 120_000);
afterAll(async () => {
  __setConfirmationIoForTests(null);
  if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

const cli = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
    cwd: dir,
    env: { ...process.env, GBRAIN_HOME: dir, ...ENV, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKIP_UPGRADE_CHECK: '1' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timeout); }
};

/** An owner page that an agent then rewrites: one lower_page proposal. */
async function loweredPage(slug: string): Promise<{ tp: string; id: number }> {
  return withEnv({ GBRAIN_HOME: dir, ...ENV }, async () => {
    const local = { ...agentCtx, remote: false, transport: undefined, auth: undefined } as unknown as OperationContext;
    await operationsByName.put_page!.handler(local, { request_id: randomUUID(), slug, content: page('Owner notes.') });
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
      await tx.executeRaw(`UPDATE pages SET trust_tier='unknown', frontmatter = frontmatter - 'trust_tier' - 'source_kind' - 'ingested_via' WHERE slug=$1`, [slug]);
      await withTrustBackfill(tx, () => tx.executeRaw(`UPDATE pages SET trust_tier='operator_curated' WHERE slug=$1`, [slug]));
    }, TEST_WRITE_ATTRIBUTION));
    const edit = await operationsByName.put_page!.handler(agentCtx, { request_id: randomUUID(), slug, content: page('Agent rewrite.'), force: true }) as Record<string, any>;
    const tp = edit.trust_lowered.proposal_ref as string;
    return { tp, id: Number(tp.slice(2)) };
  });
}
const tier = async (slug: string) => (await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE slug=$1', [slug]))[0]!.trust_tier;

describe('gbrain trust through the resident owner (DX-2)', () => {
  test('review lists the lowered page; a piped confirm is refused and changes nothing; drop dismisses', async () => {
    const { tp, id } = await loweredPage('notes/ipc-one-example');
    const review = await cli(['trust', 'review', '--json']);
    expect(review.code).toBe(0);
    expect(JSON.parse(review.stdout).items.map((i: { ref: string }) => i.ref)).toContain(tp);
    const piped = await cli(['trust', 'confirm', tp]);
    expect(piped.code).toBe(3);
    expect(piped.stderr).toContain('confirmation_required');
    expect(piped.stderr).toContain(`gbrain trust confirm ${tp}`);
    expect((await getTrustProposal(engine, id))!.status).toBe('pending');
    expect(await tier('notes/ipc-one-example')).toBe('agent_written');
    const dropped = await cli(['trust', 'drop', tp, '--json']);
    expect(dropped.code).toBe(0);
    expect(JSON.parse(dropped.stdout).result).toMatchObject({ status: 'rejected' });
    expect((await getTrustProposal(engine, id))!.status).toBe('rejected');
  }, 120_000);

  test('the typed-token prompt runs in the invoking CLI; the owner applies the approved revision', async () => {
    const { tp, id } = await loweredPage('notes/ipc-two-example');
    const input = new PassThrough();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', chunk => { prompt += String(chunk); if (prompt.includes('to confirm')) input.write(`${tp}\n`); });
    __setConfirmationIoForTests({ probe: { stdinIsTTY: true, stdoutIsTTY: true, env: { GBRAIN_INTERACTIVE: '1' } }, input, output, timeoutMs: 5000 });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      expect(await withEnv({ GBRAIN_HOME: dir, ...ENV }, () => maybeDelegateTrust(config as never, ['confirm', tp]))).toBe(true);
    } finally { console.log = log; __setConfirmationIoForTests(null); }
    expect(prompt).toContain(`Type ${tp} to confirm`);
    expect(lines.join('\n')).toContain(`${tp}: accepted`);
    expect((await getTrustProposal(engine, id))!.status).toBe('accepted');
    expect(await tier('notes/ipc-two-example')).toBe('user_confirmed');
  }, 120_000);
});

describe('an MCP session cannot reach the owner actions (ENG-15)', () => {
  test('the owner actions are administration, not tools or operation-lane IPC', () => {
    for (const op of TRUST_ADMIN_OPERATIONS) {
      expect(PERSISTENCE_ADMIN_OPERATIONS as readonly string[]).toContain(op);
      expect(operations.some(o => o.name === op)).toBe(false);
      expect(PERSISTENCE_IPC_OPERATIONS as readonly string[]).not.toContain(op);
    }
    expect(PERSISTENCE_IPC_OPERATIONS as readonly string[]).not.toContain('confirm_memory');
  });

  test('stdio and HTTP sessions: trust_apply is unknown, confirm_memory without memory_confirm is insufficient_scope', async () => {
    await loweredPage('notes/ipc-mcp-example');
    const ref = 'p:default/notes/ipc-mcp-example';
    for (const transport of ['stdio', 'http'] as const) {
      const admin = await dispatchToolCall(engine, 'trust_apply', { input: { action: 'disable' }, binding: 'x' }, { remote: true, transport });
      expect(admin.isError).toBe(true);
      expect(admin.content[0]!.text).toContain('unknown_tool');
      const confirm = await dispatchToolCall(engine, 'confirm_memory', { ref }, { remote: true, transport, sourceId: 'default', auth: { token: '', clientId: 'x', sourceId: 'default', scopes: ['read', 'write'] } as never });
      expect(confirm.isError).toBe(true);
      expect(confirm.content[0]!.text).toMatch(/insufficient_scope/);
    }
    expect(await tier('notes/ipc-mcp-example')).toBe('agent_written');
  });

  test('the owner refuses trust administration outside a verified local CLI registration', async () => {
    await expect(runTrustAdministration(engine, 'trust_apply', { input: { action: 'disable' }, binding: 'x', confirmed: 'tty' })).rejects.toMatchObject({ code: 'permission_denied', reason: 'trusted_cli_required' });
    expect(await engine.getConfig('write_gate.agent_mode')).toBeNull();
  });
});
