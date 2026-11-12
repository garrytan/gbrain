/**
 * Wakeshift PR 2 nudges (plan D9) on a repo-less PGLite brain: the `wakeshift_report_back` coaching notice on
 * remote submit_job and submit_agent (once per principal session, never again, never after mute_notice; the
 * watch_job line only while reporting back is published), and the one MCP instructions sentence that exists only
 * while it is published, so an off brain serves byte-identical instructions and hides every watch tool.
 *
 * Serial: GBRAIN_HOME (config.json, the 0600 key file, the mute store) is a temporary home set through withEnv.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { NoticeLedger } from '../src/core/notice-ledger.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { encodeWakeshiftKey } from '../src/core/wakeshift/client.ts';
import { resetWakeshiftEnvKeyForTests } from '../src/core/wakeshift/config.ts';
import { NOTICE_CODES } from '../src/core/error-registry.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { buildMcpInstructions, readInstructionContent } from '../src/mcp/instructions.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { withEnv } from './helpers/with-env.ts';

const KEY = encodeWakeshiftKey(Buffer.alloc(32, 7));
const OFF_TEXT = 'gbrain can report back when this finishes, through Wakeshift: ask the brain owner to run gbrain wakeshift enable.';
const sandbox = mkdtempSync(join(tmpdir(), 'gbrain-wakeshift-nudge-'));
const home = join(sandbox, 'home');
const root = join(sandbox, 'notes');
let engine: PGLiteEngine;
let auth: AuthInfo;

const isolated = <T>(fn: () => T | Promise<T>) => withEnv({ GBRAIN_HOME: home, WAKESHIFT_API_KEY: undefined }, fn);

function writeConfig(enabled: boolean): void {
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', ...(enabled ? { wakeshift: { enabled: true, url: 'http://127.0.0.1:1' } } : {}) }), { mode: 0o600 });
}

function noticeCodes(r: ToolResult): string[] {
  return ((r._meta?.gbrain_notices ?? []) as Array<{ code: string }>).map(n => n.code);
}
const reportBack = (r: ToolResult) => r.content.map(b => b.text).filter(t => t.startsWith('[gbrain notice wakeshift_report_back'));
const http = (ledger: NoticeLedger) => ({ remote: true, transport: 'http' as const, sourceId: 'default', auth, noticeLedger: ledger });
const jobId = (r: ToolResult) => Number(JSON.parse(r.content[0]!.text).id);

beforeAll(async () => isolated(async () => {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(root);
  writeFileSync(join(home, '.gbrain', 'wakeshift.key'), KEY + '\n', { mode: 0o600 });
  resetWakeshiftEnvKeyForTests();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET config = '{}'::jsonb, archived = false, local_path = $1 WHERE id = 'default'", [root]);
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const reg = await provider.registerClientManual('agent-example', ['client_credentials'], 'read write admin', [], 'default');
  await engine.executeRaw("UPDATE oauth_clients SET scope = 'read write admin agent', bound_tools = $2, bound_source_id = source_id, federated_read = ARRAY[source_id], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 50 WHERE client_id = $1", [reg.clientId, ['get_page', 'search']]);
  auth = await provider.verifyAccessToken((await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!)).access_token) as unknown as AuthInfo;
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  rmSync(join(home, '.gbrain', 'notices'), { recursive: true, force: true });
});

describe('wakeshift_report_back coaching notice', () => {
  test('is a registered, muteable coaching code', () => {
    expect(NOTICE_CODES.wakeshift_report_back).toMatchObject({ kind: 'coaching' });
  });

  test('off: the first long submit carries the enable hint once, then never again in the session', () => isolated(async () => {
    writeConfig(false);
    const ledger = new NoticeLedger();
    const first = await dispatchToolCall(engine, 'submit_job', { name: 'lint', data: {} }, http(ledger));
    expect(first.isError).toBeFalsy();
    expect(noticeCodes(first)).toContain('wakeshift_report_back');
    expect(reportBack(first)).toHaveLength(1);
    expect(reportBack(first)[0]).toContain(OFF_TEXT);
    expect(first.content.map(b => b.text).join('\n')).not.toContain('watch_job');
    for (const [op, params] of [['submit_job', { name: 'lint', data: {} }], ['submit_agent', { prompt: 'Summarize the notes' }], ['submit_job', { name: 'lint-fix', data: {} }]] as const) {
      const again = await dispatchToolCall(engine, op, params, http(ledger));
      expect(again.isError).toBeFalsy();
      expect(noticeCodes(again)).not.toContain('wakeshift_report_back');
      expect(reportBack(again)).toEqual([]);
    }
  }));

  test('on: submit_agent offers watch_job with its own job id, once', () => isolated(async () => {
    writeConfig(true);
    const ledger = new NoticeLedger();
    const first = await dispatchToolCall(engine, 'submit_agent', { prompt: 'Summarize the notes' }, http(ledger));
    expect(first.isError).toBeFalsy();
    expect(reportBack(first)).toHaveLength(1);
    expect(reportBack(first)[0]).toContain(`Want this conversation woken when it's done? Call watch_job with id ${jobId(first)}.`);
    const second = await dispatchToolCall(engine, 'submit_job', { name: 'lint', data: {} }, http(ledger));
    expect(reportBack(second)).toEqual([]);
  }));

  test('never after mute_notice, in this session or a later one', () => isolated(async () => {
    writeConfig(false);
    const muted = await dispatchToolCall(engine, 'mute_notice', { code: 'wakeshift_report_back' }, http(new NoticeLedger()));
    expect(muted.isError).toBeFalsy();
    for (const ledger of [new NoticeLedger(), new NoticeLedger()]) {
      const r = await dispatchToolCall(engine, 'submit_job', { name: 'lint', data: {} }, http(ledger));
      expect(r.isError).toBeFalsy();
      expect(noticeCodes(r)).not.toContain('wakeshift_report_back');
      expect(reportBack(r)).toEqual([]);
    }
  }));

  test('a trusted local CLI submit gets no hint (it has no conversation to wake)', () => isolated(async () => {
    writeConfig(true);
    const notices: Notice[] = [];
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
    await operationsByName.submit_job!.handler(ctx, { name: 'lint', data: {} });
    expect(notices.map(n => n.code)).not.toContain('wakeshift_report_back');
  }));
});

describe('MCP instructions and tools/list', () => {
  const callable = () => true;
  const watchless = (name: string) => !name.startsWith('watch_') && name !== 'list_watches' && name !== 'unwatch';

  test('off: instructions are byte-identical to the rendering without Wakeshift, and every watch tool is hidden', () => isolated(async () => {
    writeConfig(false);
    const content = await readInstructionContent(engine);
    const served = buildMcpInstructions({ tools: { callable }, ...content });
    const { references, governingRule } = content;
    expect(served).toBe(buildMcpInstructions({ tools: { callable }, references, governingRule }));
    expect(served).not.toContain('watch_job');
    const gated = OPERATION_MANIFEST.filter(op => op.publishGateKey === 'mcp.publish_wakeshift').map(op => op.name);
    expect(gated).toContain('watch_job');
    const disabled = await disabledOpsForPublishGates(engine, null, { transport: 'http' });
    for (const name of gated) expect(disabled.has(name)).toBe(true);
  }));

  test('on: exactly one added sentence, and only where watch_job is callable', () => isolated(async () => {
    writeConfig(true);
    const content = await readInstructionContent(engine);
    const { references, governingRule } = content;
    const base = buildMcpInstructions({ tools: { callable }, references, governingRule });
    const served = buildMcpInstructions({ tools: { callable }, ...content });
    expect(served).not.toBe(base);
    expect(served.split('\n').filter(l => !base.split('\n').includes(l))).toHaveLength(1);
    expect(served.match(/watch_job/g)).toHaveLength(1);
    expect(buildMcpInstructions({ tools: { callable: watchless }, ...content })).toBe(buildMcpInstructions({ tools: { callable: watchless }, references, governingRule }));
  }));
});
