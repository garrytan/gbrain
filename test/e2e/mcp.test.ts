/**
 * E2E MCP Protocol Test — Tier 1
 *
 * Verifies the generated MCP tool definitions and the real stdio MCP server
 * path used by agents. The stdio test spawns `mbrain serve`, calls tools/list,
 * and exercises tools/call against an isolated local SQLite brain.
 */

import { describe, test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { operations } from '../../src/core/operations.ts';
import { operationToMcpTool } from '../../src/mcp/tool-schema.ts';
import { DEFAULT_MCP_MAX_STDIO_FRAME_BYTES } from '../../src/mcp/stdio-frame-budget.ts';
import { assertOk, createSqliteCliHarness, parseJsonSuffix } from './sqlite-cli-helpers.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function parseMcpText<T = any>(result: any): T {
  expect(result.isError).not.toBe(true);
  const text = result.content?.find((entry: any) => entry.type === 'text')?.text;
  expect(typeof text).toBe('string');
  return parseJsonSuffix<T>(text);
}

const rpcEncoder = new TextEncoder();
const rpcDecoder = new TextDecoder();

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type JsonRpcStdin = {
  write: (chunk: Uint8Array) => unknown;
  flush?: () => unknown;
  end?: () => unknown;
  close?: () => unknown;
};

type BudgetedJsonRpcFrame = {
  line: string;
  frameBytes: number;
  response: any;
};

function expectReadableStream(value: unknown, label: string): ReadableStream<Uint8Array> {
  if (!value || typeof (value as any).getReader !== 'function') {
    throw new Error(`Expected readable ${label}`);
  }
  return value as ReadableStream<Uint8Array>;
}

function expectJsonRpcStdin(value: unknown): JsonRpcStdin {
  if (!value || typeof (value as any).write !== 'function') {
    throw new Error('Expected writable MCP stdin');
  }
  return value as JsonRpcStdin;
}

function createJsonLineReader(stream: ReadableStream<Uint8Array>, label: string) {
  const reader = stream.getReader();
  let buffer = '';

  async function readLine(timeoutMs = 5_000): Promise<string> {
    const startedAt = Date.now();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new Error(`Timed out waiting for ${label} line; buffered=${buffer}`);
      }

      const chunk = await Promise.race([
        reader.read(),
        sleep(remainingMs).then(() => {
          throw new Error(`Timed out waiting for ${label} line; buffered=${buffer}`);
        }),
      ]);
      if (chunk.done) {
        throw new Error(`Unexpected EOF while reading ${label}; buffered=${buffer}`);
      }
      buffer += rpcDecoder.decode(chunk.value, { stream: true });
    }
  }

  return {
    readLine,
    cancel: () => reader.cancel(),
  };
}

async function writeJsonRpc(
  stdin: JsonRpcStdin,
  message: Record<string, unknown>,
): Promise<void> {
  stdin.write(rpcEncoder.encode(`${JSON.stringify(message)}\n`));
  await stdin.flush?.();
}

async function readBudgetedJsonRpcFrame(
  stdout: ReturnType<typeof createJsonLineReader>,
  expectedId: number,
  maxFrameBytes = DEFAULT_MCP_MAX_STDIO_FRAME_BYTES,
): Promise<BudgetedJsonRpcFrame> {
  const line = await stdout.readLine();
  const response = JSON.parse(line);
  const frameBytes = byteLength(`${line}\n`);
  expect(response.id).toBe(expectedId);
  expect(frameBytes).toBeLessThanOrEqual(maxFrameBytes);
  return { line, frameBytes, response };
}

async function readBudgetedJsonRpcResponse(
  stdout: ReturnType<typeof createJsonLineReader>,
  expectedId: number,
  maxFrameBytes = DEFAULT_MCP_MAX_STDIO_FRAME_BYTES,
): Promise<any> {
  return (await readBudgetedJsonRpcFrame(stdout, expectedId, maxFrameBytes)).response;
}

async function closeJsonRpcStdin(stdin: JsonRpcStdin | null): Promise<void> {
  if (!stdin) return;
  await Promise.resolve(stdin.flush?.()).catch(() => undefined);
  await Promise.resolve(stdin.end?.()).catch(() => undefined);
  await Promise.resolve(stdin.close?.()).catch(() => undefined);
}

async function waitForProcessExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (proc.exitCode !== null) return true;
  return Promise.race([
    proc.exited.then(() => true).catch(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function settleStderrText(
  stderrText: Promise<string> | null,
  timeoutMs: number,
): Promise<void> {
  if (!stderrText) return;
  await Promise.race([
    stderrText.catch(() => ''),
    sleep(timeoutMs).then(() => ''),
  ]);
}

async function cleanupRawMcpProcess(input: {
  proc: ReturnType<typeof Bun.spawn> | null;
  stdin: JsonRpcStdin | null;
  stdout: ReturnType<typeof createJsonLineReader> | null;
  stderrText: Promise<string> | null;
}): Promise<void> {
  await closeJsonRpcStdin(input.stdin);
  await input.stdout?.cancel().catch(() => undefined);

  if (input.proc && input.proc.exitCode === null) {
    input.proc.kill('SIGTERM');
    if (!await waitForProcessExit(input.proc, 2_000) && input.proc.exitCode === null) {
      input.proc.kill('SIGKILL');
      if (!await waitForProcessExit(input.proc, 2_000)) {
        input.proc.unref();
      }
    }
  }

  await settleStderrText(input.stderrText, 500);
}

describe('E2E: MCP Tool Generation', () => {
  test('operations generate valid MCP tool definitions', () => {
    // This replicates exactly what server.ts does in the tools/list handler
    const tools = operations.map((operation) => operationToMcpTool(operation));

    expect(tools.length).toBe(operations.length);
    expect(tools.length).toBeGreaterThanOrEqual(30);

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }

    // Verify specific tools exist
    const names = tools.map(t => t.name);
    expect(names).toContain('get_page');
    expect(names).toContain('put_page');
    expect(names).toContain('search');
    expect(names).toContain('query');
    expect(names).toContain('add_link');
    expect(names).toContain('get_health');
    expect(names).toContain('sync_brain');
    expect(names).toContain('file_upload');
    expect(names).toContain('list_memory_mutation_events');
    expect(names).toContain('record_memory_mutation_event');
    expect(names).toContain('dry_run_memory_mutation');
    expect(names).toContain('upsert_memory_realm');
    expect(names).toContain('get_memory_session');
    expect(names).toContain('list_memory_sessions');
    expect(names).toContain('create_memory_redaction_plan');
    expect(names).toContain('apply_memory_redaction_plan');
    const recordMutationEvent = tools.find((tool) => tool.name === 'record_memory_mutation_event');
    expect((recordMutationEvent?.inputSchema.properties as any).privileged.type).toBe('boolean');
    expect(recordMutationEvent?.inputSchema.required).toContain('privileged');
    expect(recordMutationEvent?.inputSchema.required).toContain('privileged_reason');
    expect(recordMutationEvent?.inputSchema.required).toContain('target_id');
    expect(recordMutationEvent?.inputSchema.required).toContain('source_refs');
    expect((recordMutationEvent?.inputSchema.properties as any).source_ref).toBeUndefined();
    expect((recordMutationEvent?.inputSchema.properties as any).mutation_dry_run.type).toBe('boolean');
    const putPage = tools.find((tool) => tool.name === 'put_page');
    expect((putPage?.inputSchema.properties as any).expected_content_hash.type).toEqual(['string', 'null']);
    const dryRunMutation = tools.find((tool) => tool.name === 'dry_run_memory_mutation');
    expect(dryRunMutation?.inputSchema.required).toEqual([
      'session_id',
      'realm_id',
      'target_kind',
      'target_id',
      'operation',
      'source_refs',
    ]);
    expect((dryRunMutation?.inputSchema.properties as any).dry_run.type).toBe('boolean');
    expect((dryRunMutation?.inputSchema.properties as any).scope_id.type).toEqual(['string', 'null']);
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).toContain('put_page');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).not.toContain('create_memory_session');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).not.toContain('upsert_memory_realm');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).not.toContain('record_memory_mutation_event');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).not.toContain('repair_memory_ledger');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).not.toContain('physical_delete_memory_record');
    expect((dryRunMutation?.inputSchema.properties as any).target_kind.enum).toContain('profile_memory');
    expect((dryRunMutation?.inputSchema.properties as any).target_kind.enum).not.toContain('source_record');
    const upsertMemoryRealm = tools.find((tool) => tool.name === 'upsert_memory_realm');
    expect((upsertMemoryRealm?.inputSchema.properties as any).archived_at.type).toEqual(['string', 'null']);
    const createPatchCandidate = tools.find((tool) => tool.name === 'create_memory_patch_candidate');
    expect((createPatchCandidate?.inputSchema.properties as any).patch_body.type).toEqual(['object', 'array']);
    expect((createPatchCandidate?.inputSchema.properties as any).target_kind.enum).toContain('page');
    expect((createPatchCandidate?.inputSchema.properties as any).target_kind.enum).not.toContain('source_record');
    const reviewPatchCandidate = tools.find((tool) => tool.name === 'review_memory_patch_candidate');
    expect((reviewPatchCandidate?.inputSchema.properties as any).decision.enum).toEqual(['approve', 'reject']);
    const applyPatchCandidate = tools.find((tool) => tool.name === 'apply_memory_patch_candidate');
    expect((applyPatchCandidate?.inputSchema.properties as any).candidate_id.type).toBe('string');
    const listMemoryCandidates = tools.find((tool) => tool.name === 'list_memory_candidate_entries');
    expect((listMemoryCandidates?.inputSchema.properties as any).patch_operation_state.enum).toContain('approved_for_apply');
    expect((listMemoryCandidates?.inputSchema.properties as any).patch_target_kind.enum).toContain('page');
    const createRedactionPlan = tools.find((tool) => tool.name === 'create_memory_redaction_plan');
    expect(createRedactionPlan?.inputSchema.required).toContain('scope_id');
    expect(createRedactionPlan?.inputSchema.required).toContain('query');
    const applyRedactionPlan = tools.find((tool) => tool.name === 'apply_memory_redaction_plan');
    expect((applyRedactionPlan?.inputSchema.properties as any).actor.type).toBe('string');
    const routeWriteback = tools.find((tool) => tool.name === 'route_memory_writeback');
    expect(routeWriteback?.inputSchema.required).toContain('content');
    expect(routeWriteback?.inputSchema.required).toContain('evidence_kind');
    expect((routeWriteback?.inputSchema.properties as any).evidence_kind.enum).toContain('agent_inferred');
    expect((routeWriteback?.inputSchema.properties as any).apply.type).toBe('boolean');
    expect((routeWriteback?.inputSchema.properties as any).target_snapshot_hash.type).toEqual(['string', 'null']);
  });

  test('MCP server module can be imported', async () => {
    // Verify the server module loads without errors
    const mod = await import('../../src/mcp/server.ts');
    expect(typeof mod.startMcpServer).toBe('function');
    expect(typeof mod.handleToolCall).toBe('function');
  });

  test('stdio MCP server bootstraps a local SQLite config when no database config exists', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'mbrain-mcp-fresh-'));
    const homeDir = join(rootDir, 'home');
    const configDir = join(homeDir, '.mbrain');
    let client: Client | null = null;

    try {
      const transport = new StdioClientTransport({
        command: 'bun',
        args: ['run', 'src/cli.ts', 'serve'],
        cwd: repoRoot,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: homeDir,
          MBRAIN_CONFIG_DIR: configDir,
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
        },
        stderr: 'pipe',
      });
      client = new Client(
        { name: 'mbrain-fresh-e2e', version: '0.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('get_page');

      const configPath = join(configDir, 'config.json');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.engine).toBe('sqlite');
      expect(config.database_path).toBe(join(configDir, 'brain.db'));
    } finally {
      try {
        if (client) await client.close();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test('raw stdio MCP server keeps all response frames within configured budgets', async () => {
    const h = createSqliteCliHarness('mcp-raw-budget');
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let stdout: ReturnType<typeof createJsonLineReader> | null = null;
    let stderrText: Promise<string> | null = null;
    let stdin: JsonRpcStdin | null = null;

    try {
      const init = h.run(['init', '--local', '--json']);
      assertOk(init, ['init', '--local', '--json']);

      proc = Bun.spawn({
        cmd: ['bun', 'run', 'src/cli.ts', 'serve'],
        cwd: repoRoot,
        env: {
          ...h.env,
          MBRAIN_MCP_MAX_STDIO_FRAME_BYTES: '24000',
          MBRAIN_MCP_TOOL_LIST_FRAME_BYTES: '64000',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      stderrText = new Response(expectReadableStream(proc.stderr, 'MCP stderr')).text();
      stdout = createJsonLineReader(expectReadableStream(proc.stdout, 'MCP stdout'), 'MCP stdout');
      stdin = expectJsonRpcStdin(proc.stdin);

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mbrain-raw-e2e', version: '0.0.0' },
        },
      });
      const initialized = await readBudgetedJsonRpcResponse(stdout, 1);
      expect(initialized.result.serverInfo.name).toBe('mbrain');

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const listed = await readBudgetedJsonRpcResponse(stdout, 2, 64_000);
      expect(listed.result.tools.map((tool: any) => tool.name)).toContain('get_health');

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_health', arguments: {} },
      });
      const health = await readBudgetedJsonRpcResponse(stdout, 3);
      expect(health.result.content[0].type).toBe('text');
      expect(() => JSON.parse(health.result.content[0].text)).not.toThrow();

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_page', arguments: { slug: 'brain/missing-page' } },
      });
      const missingPage = await readBudgetedJsonRpcResponse(stdout, 4);
      expect(missingPage.result.isError).toBe(true);
      expect(JSON.parse(missingPage.result.content[0].text).error).toBe('page_not_found');

      const oversizedSlug = 'concepts/mcp-oversized-stdio-page';
      const oversizedContent = [
        '---',
        'type: concept',
        'title: MCP Oversized Stdio Page',
        'tags: [mcp, e2e]',
        '---',
        '',
        `This oversized MCP page exercises stdio response guarding. ${'A'.repeat(80_000)} [Source: MCP E2E, direct tool call, 2026-05-12 00:00 KST]`,
        '',
        '---',
        '',
        `- 2026-05-12 | Oversized stdio timeline evidence. ${'B'.repeat(40_000)} [Source: MCP E2E, direct tool call, 2026-05-12 00:00 KST]`,
        '',
      ].join('\n');

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'put_page',
          arguments: {
            slug: oversizedSlug,
            content: oversizedContent,
            expected_content_hash: null,
          },
        },
      });
      const putOversized = await readBudgetedJsonRpcResponse(stdout, 5);
      expect(JSON.parse(putOversized.result.content[0].text).slug).toBe(oversizedSlug);

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'get_page',
          arguments: { slug: oversizedSlug, full_content: true },
        },
      });
      const oversizedRead = await readBudgetedJsonRpcFrame(stdout, 6, DEFAULT_MCP_MAX_STDIO_FRAME_BYTES);
      expect(oversizedRead.frameBytes).toBeLessThanOrEqual(24_000);
      if ('error' in oversizedRead.response) {
        expect(oversizedRead.response.error.message).toContain('MBrain MCP stdio frame exceeded byte budget');
      } else {
        const contentText = oversizedRead.response.result.content[0].text;
        expect(byteLength(contentText)).toBeLessThanOrEqual(DEFAULT_MCP_MAX_STDIO_FRAME_BYTES);
        const content = JSON.parse(contentText);
        expect(content.slug).toBe(oversizedSlug);
        expect(content.compiled_truth.length).toBeLessThan(80_000);
        expect(content._mbrain_mcp_response.truncated).toBe(true);
      }

      await writeJsonRpc(stdin, {
        jsonrpc: '2.0',
        id: 7,
        method: 'mbrain/unknown',
        params: {},
      });
      const unknown = await readBudgetedJsonRpcResponse(stdout, 7);
      expect(unknown.error.code).toBe(-32601);
    } finally {
      await cleanupRawMcpProcess({ proc, stdin, stdout, stderrText });
      h.teardown();
    }
  }, 30_000);

  test('stdio MCP server exposes and executes local SQLite memory lifecycle tools', async () => {
    const h = createSqliteCliHarness('mcp');
    let client: Client | null = null;

    try {
      const init = h.run(['init', '--local', '--json']);
      assertOk(init, ['init', '--local', '--json']);

      const transport = new StdioClientTransport({
        command: 'bun',
        args: ['run', 'src/cli.ts', 'serve'],
        cwd: repoRoot,
        env: { ...h.env, MBRAIN_ENABLE_PRIVILEGED_LEDGER_RECORD: '1' },
        stderr: 'pipe',
      });
      client = new Client(
        { name: 'mbrain-e2e', version: '0.0.0' },
        { capabilities: {} },
      );

      await client.connect(transport);

      const tools = await client.listTools();
      const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
      for (const name of [
        'write_profile_memory_entry',
        'get_profile_memory_entry',
        'delete_profile_memory_entry',
        'write_personal_episode_entry',
        'get_personal_episode_entry',
        'delete_personal_episode_entry',
        'create_memory_candidate_entry',
        'get_memory_candidate_entry',
        'delete_memory_candidate_entry',
        'record_canonical_handoff',
        'record_memory_mutation_event',
        'list_memory_mutation_events',
        'upsert_memory_realm',
        'get_memory_realm',
        'create_memory_session',
        'attach_memory_realm_to_session',
        'list_memory_session_attachments',
        'create_memory_patch_candidate',
        'create_memory_redaction_plan',
        'get_memory_operations_health',
      ]) {
        expect(byName.has(name)).toBe(true);
      }
      expect((byName.get('record_canonical_handoff')?.inputSchema.properties as any).interaction_id.type).toBe('string');

      const profileId = 'mcp-profile-delete-me';
      const profile = parseMcpText<any>(await client.callTool({
        name: 'write_profile_memory_entry',
        arguments: {
          id: profileId,
          requested_scope: 'personal',
          profile_type: 'preference',
          subject: 'mcp sqlite lifecycle',
          content: 'MCP writes profile memory into the local SQLite brain.',
          source_ref: 'MCP E2E, direct tool call, 2026-04-25 18:50 KST',
        },
      }));
      expect(profile.id).toBe(profileId);
      expect(parseMcpText<any>(await client.callTool({
        name: 'get_profile_memory_entry',
        arguments: { id: profileId },
      })).content).toContain('local SQLite brain');
      expect(parseMcpText<any>(await client.callTool({
        name: 'delete_profile_memory_entry',
        arguments: { id: profileId },
      }))).toMatchObject({ status: 'deleted', id: profileId });
      expect(parseMcpText<any | null>(await client.callTool({
        name: 'get_profile_memory_entry',
        arguments: { id: profileId },
      }))).toBeNull();
      const profilesAfterDelete = parseMcpText<any[]>(await client.callTool({
        name: 'list_profile_memory_entries',
        arguments: { subject: 'mcp sqlite lifecycle' },
      }));
      expect(profilesAfterDelete.map((entry) => entry.id)).not.toContain(profileId);

      const episodeId = 'mcp-episode-delete-me';
      expect(parseMcpText<any>(await client.callTool({
        name: 'write_personal_episode_entry',
        arguments: {
          id: episodeId,
          requested_scope: 'personal',
          title: 'MCP SQLite episode lifecycle',
          start_time: '2026-04-25T09:50:00Z',
          source_kind: 'chat',
          summary: 'MCP writes an episode into the local SQLite brain.',
          source_ref: 'MCP E2E, direct tool call, 2026-04-25 18:50 KST',
        },
      })).id).toBe(episodeId);
      expect(parseMcpText<any>(await client.callTool({
        name: 'delete_personal_episode_entry',
        arguments: { id: episodeId },
      }))).toMatchObject({ status: 'deleted', id: episodeId });
      expect(parseMcpText<any | null>(await client.callTool({
        name: 'get_personal_episode_entry',
        arguments: { id: episodeId },
      }))).toBeNull();
      const episodesAfterDelete = parseMcpText<any[]>(await client.callTool({
        name: 'list_personal_episode_entries',
        arguments: { title: 'MCP SQLite episode lifecycle' },
      }));
      expect(episodesAfterDelete.map((entry) => entry.id)).not.toContain(episodeId);

      const candidateId = 'mcp-candidate-delete-me';
      expect(parseMcpText<any>(await client.callTool({
        name: 'create_memory_candidate_entry',
        arguments: {
          id: candidateId,
          candidate_type: 'fact',
          proposed_content: 'MCP writes a memory candidate into the local SQLite brain.',
          source_ref: 'MCP E2E, direct tool call, 2026-04-25 18:50 KST',
          target_object_type: 'profile_memory',
          target_object_id: profileId,
          interaction_id: 'mcp-trace-delete',
        },
      })).id).toBe(candidateId);
      expect(parseMcpText<any>(await client.callTool({
        name: 'get_memory_candidate_entry',
        arguments: { id: candidateId },
      })).source_refs).toContain('MCP E2E, direct tool call, 2026-04-25 18:50 KST');
      expect(parseMcpText<any>(await client.callTool({
        name: 'delete_memory_candidate_entry',
        arguments: { id: candidateId },
      }))).toMatchObject({ status: 'deleted', id: candidateId });
      expect(parseMcpText<any | null>(await client.callTool({
        name: 'get_memory_candidate_entry',
        arguments: { id: candidateId },
      }))).toBeNull();
      const candidatesAfterDelete = parseMcpText<any[]>(await client.callTool({
        name: 'list_memory_candidate_entries',
        arguments: { status: 'captured', limit: 50 },
      }));
      expect(candidatesAfterDelete.map((entry) => entry.id)).not.toContain(candidateId);

      const handoffCandidateId = 'mcp-candidate-handoff';
      parseMcpText(await client.callTool({
        name: 'create_memory_candidate_entry',
        arguments: {
          id: handoffCandidateId,
          candidate_type: 'fact',
          proposed_content: 'MCP handoff candidate preserves interaction attribution.',
          source_ref: 'MCP E2E, handoff provenance, 2026-04-25 18:51 KST',
          sensitivity: 'personal',
          target_object_type: 'profile_memory',
          target_object_id: 'mcp-profile-handoff',
          interaction_id: 'mcp-trace-handoff',
        },
      }));
      parseMcpText(await client.callTool({
        name: 'advance_memory_candidate_status',
        arguments: { id: handoffCandidateId, next_status: 'candidate', interaction_id: 'mcp-trace-handoff' },
      }));
      parseMcpText(await client.callTool({
        name: 'advance_memory_candidate_status',
        arguments: { id: handoffCandidateId, next_status: 'staged_for_review', interaction_id: 'mcp-trace-handoff' },
      }));
      parseMcpText(await client.callTool({
        name: 'promote_memory_candidate_entry',
        arguments: {
          id: handoffCandidateId,
          review_reason: 'MCP promotion path preserves provenance.',
          interaction_id: 'mcp-trace-handoff',
        },
      }));
      const handoff = parseMcpText<any>(await client.callTool({
        name: 'record_canonical_handoff',
        arguments: {
          candidate_id: handoffCandidateId,
          review_reason: 'MCP canonical handoff attribution.',
          interaction_id: 'mcp-trace-handoff',
        },
      }));
      expect(handoff.handoff.interaction_id).toBe('mcp-trace-handoff');
      const persistedHandoffs = parseMcpText<any[]>(await client.callTool({
        name: 'list_canonical_handoff_entries',
        arguments: { candidate_id: handoffCandidateId },
      }));
      expect(persistedHandoffs.map((entry) => entry.interaction_id)).toContain('mcp-trace-handoff');

      const mutation = parseMcpText<any>(await client.callTool({
        name: 'record_memory_mutation_event',
        arguments: {
          privileged: true,
          privileged_reason: 'MCP E2E validates privileged ledger exposure.',
          id: 'mcp-ledger-event',
          session_id: 'mcp-session-ledger',
          realm_id: 'mcp-realm-ledger',
          actor: 'mcp-e2e',
          operation: 'repair_memory_ledger',
          target_kind: 'ledger_event',
          target_id: 'mcp-ledger-target',
          scope_id: 'workspace:default',
          source_refs: ['MCP E2E, privileged ledger call, 2026-04-26 22:00 KST'],
          result: 'applied',
        },
      }));
      expect(mutation.id).toBe('mcp-ledger-event');

      const mutations = parseMcpText<any[]>(await client.callTool({
        name: 'list_memory_mutation_events',
        arguments: { session_id: 'mcp-session-ledger', limit: 10 },
      }));
      expect(mutations.map((entry) => entry.id)).toContain('mcp-ledger-event');
    } finally {
      try {
        if (client) await client.close();
      } finally {
        h.teardown();
      }
    }
  }, 60_000);
});
