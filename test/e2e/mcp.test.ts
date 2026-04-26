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
import { fileURLToPath } from 'url';
import { operations } from '../../src/core/operations.ts';
import { operationToMcpTool } from '../../src/mcp/tool-schema.ts';
import { assertOk, createSqliteCliHarness, parseJsonSuffix } from './sqlite-cli-helpers.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function parseMcpText<T = any>(result: any): T {
  expect(result.isError).not.toBe(true);
  const text = result.content?.find((entry: any) => entry.type === 'text')?.text;
  expect(typeof text).toBe('string');
  return parseJsonSuffix<T>(text);
}

describe('E2E: MCP Tool Generation', () => {
  test('operations generate valid MCP tool definitions', () => {
    // This replicates exactly what server.ts does in the tools/list handler
    const tools = operations.map(operationToMcpTool);

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
    const recordMutationEvent = tools.find((tool) => tool.name === 'record_memory_mutation_event');
    expect((recordMutationEvent?.inputSchema.properties as any).privileged.type).toBe('boolean');
    expect(recordMutationEvent?.inputSchema.required).toContain('privileged');
    expect(recordMutationEvent?.inputSchema.required).toContain('privileged_reason');
    expect(recordMutationEvent?.inputSchema.required).toContain('target_id');
    expect(recordMutationEvent?.inputSchema.required).toContain('source_refs');
    expect((recordMutationEvent?.inputSchema.properties as any).source_ref).toBeUndefined();
    expect((recordMutationEvent?.inputSchema.properties as any).mutation_dry_run.type).toBe('boolean');
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
  });

  test('MCP server module can be imported', async () => {
    // Verify the server module loads without errors
    const mod = await import('../../src/mcp/server.ts');
    expect(typeof mod.startMcpServer).toBe('function');
    expect(typeof mod.handleToolCall).toBe('function');
  });

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
        env: h.env,
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
    } finally {
      try {
        if (client) await client.close();
      } finally {
        h.teardown();
      }
    }
  }, 60_000);
});
