/**
 * GST-359 D: the QM memory-provider contract fixtures (docs/contracts/qm-memory-provider/v1.json, v2.json and v3.json).
 *
 * 1. Protects: the committed fixture QM vendors equals what the live registry, actor model and error registry produce,
 *    and it pins the r3 contract values (actor id pattern, stateless session, success codes in structuredContent).
 * 2. Fails when: a tool's arguments, a limit, an error code or reason, the header or the deferred list changes without
 *    regenerating the fixture, or an actor_not_attested reason has no fix row.
 * 3. Existing coverage: none; test/qm-memory-tools.test.ts pins the behaviour the fixture describes.
 * 4. Real seams: the operation registry and paramDefToSchema (the served tool schema); no engine.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTOR_REASON_FIXES, QM_CONTRACT_PATH, QM_CONTRACT_PATHS, renderQmMemoryContract } from '../scripts/build-qm-memory-contract.ts';
import { CODES } from '../src/core/error-registry.ts';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { QM_PERSONAL_OPS, unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';
import { WRITE_REQUEST_STATES } from '../src/core/persistence/types.ts';
import { DEFAULT_ATTEST_OPS } from '../src/core/access/actor-model.ts';

/** The v1 bytes QM vendored for the 11-06 tag (GBRA-108, GST-359): v1 never changes while QM depends on it. */
const V1_SHA256 = 'c80a7a5f8133f875ef90a2b5052a53c4d2bb0ab95facfa3975ba626c00daae78';

describe('QM memory-provider contract v1', () => {
  const fixture = JSON.parse(readFileSync(QM_CONTRACT_PATH, 'utf8'));

  test('the committed fixture matches the live registry (regenerate with bun scripts/build-qm-memory-contract.ts)', () => {
    expect(readFileSync(QM_CONTRACT_PATH, 'utf8')).toBe(renderQmMemoryContract(1));
  });

  test('v1 is frozen byte for byte at the vendored sha256, on disk and as the builder renders it', () => {
    expect(createHash('sha256').update(readFileSync(QM_CONTRACT_PATH)).digest('hex')).toBe(V1_SHA256);
    expect(createHash('sha256').update(renderQmMemoryContract(1)).digest('hex')).toBe(V1_SHA256);
    const recall = fixture.tools.find((t: { name: string }) => t.name === 'memory_recall');
    expect(Object.keys(recall.input_schema.properties).sort()).toEqual(['acting_user', 'max_chars', 'query']);
    expect(fixture.memory_recall.scope_read).toBeUndefined();
  });

  test('it pins the r3 contract values', () => {
    expect(fixture.actor.header).toBe('x-qm-actor');
    expect(fixture.actor.actor_id.pattern).toBe('^[\\x21-\\x7e]{1,256}$');
    expect(fixture.transport).toMatchObject({ session: 'stateless', success_codes_in: 'structuredContent' });
    expect(fixture.unlinked_recall).toEqual({ isError: false, ...unlinkedRecallResult() });
    expect(fixture.unlinked_recall.structuredContent).toEqual({ facts: [], truncated: false, code: 'actor_unlinked' });
    expect(fixture.memory_recall.limits.max_chars).toEqual({ min: 200, max: 12000, default: 6000, whole_number: true, unit: 'UTF-16 code units (JavaScript string length)' });
    expect(fixture.tools.find((t: { name: string }) => t.name === 'memory_recall').input_schema.properties.max_chars.type).toBe('integer');
    expect(fixture.wave_2).toMatchObject({ audience_header: 'x-qm-audience', status: 'refused until wave 2', refusal: { code: 'actor_not_attested', reason: 'audience_not_supported' } });
    expect(fixture.actor.default_attest_ops).toEqual(['get_write_request', 'memory_recall', 'memory_write']);
    const codes = fixture.errors.codes.map((c: { code: string }) => c.code);
    expect(codes).not.toContain('rate_limited');
    for (const code of ['unavailable', 'unknown_tool', 'not_found', 'fact_not_found']) expect(codes).toContain(code);
    expect(fixture.memory_write.limits.facts).toEqual({ min: 1, max: 20 });
    expect(fixture.actor.deferred_ops).not.toContain('forget');
    expect(fixture.actor.deferred_ops).not.toContain('forget_fact');
  });

  test('v1 tool schemas are the served ones restricted to v1\'s arguments', () => {
    const served = buildToolDefs(operations.filter(o => o.name === 'memory_recall' || o.name === 'memory_write'));
    for (const tool of fixture.tools) {
      const def = served.find(d => d.name === tool.name)!;
      const properties = Object.fromEntries(Object.entries(def.inputSchema.properties as Record<string, unknown>).filter(([k]) => k in tool.input_schema.properties));
      expect({ description: tool.description, ...tool.input_schema }).toEqual({ description: def.description, ...def.inputSchema, properties });
    }
  });

  test('every actor_not_attested reason carries its fix, and every listed code is registered', () => {
    expect(Object.keys(ACTOR_REASON_FIXES).sort()).toEqual([...(CODES.actor_not_attested.reasons ?? [])].sort());
    const attested = fixture.errors.codes.find((c: { code: string }) => c.code === 'actor_not_attested');
    for (const r of attested.reasons) expect(r.fix.length).toBeGreaterThan(10);
    for (const c of fixture.errors.codes) expect(CODES[c.code as keyof typeof CODES]).toBeDefined();
  });
});

describe('QM memory-provider contract v2 (GST-1094 scope read, GST-900)', () => {
  const fixture = JSON.parse(readFileSync(QM_CONTRACT_PATHS[2], 'utf8'));

  test('the committed fixture matches the live registry (regenerate with bun scripts/build-qm-memory-contract.ts)', () => {
    expect(readFileSync(QM_CONTRACT_PATHS[2], 'utf8')).toBe(renderQmMemoryContract(2));
  });

  test('v2 is written beside v1 at the path QM vendors', () => {
    expect(QM_CONTRACT_PATHS[2].endsWith(join('docs', 'contracts', 'qm-memory-provider', 'v2.json'))).toBe(true);
    expect(QM_CONTRACT_PATHS[1].endsWith(join('docs', 'contracts', 'qm-memory-provider', 'v1.json'))).toBe(true);
  });

  test('the tool schemas are the ones MCP serves, restricted to v2\'s arguments (v3 adds query_keep)', () => {
    const served = buildToolDefs(operations.filter(o => o.name === 'memory_recall' || o.name === 'memory_write'));
    for (const tool of fixture.tools) {
      const def = served.find(d => d.name === tool.name)!;
      const servedKeys = Object.keys(def.inputSchema.properties as Record<string, unknown>);
      expect(servedKeys.filter(k => !(k in tool.input_schema.properties))).toEqual(tool.name === 'memory_recall' ? ['query_keep'] : []);
      const properties = Object.fromEntries(Object.entries(def.inputSchema.properties as Record<string, unknown>).filter(([k]) => k in tool.input_schema.properties));
      expect({ description: tool.description, ...tool.input_schema }).toEqual({ description: def.description, ...def.inputSchema, properties });
    }
  });

  test('it publishes the scope read, the member-bound acting_user rule and _meta-only unknown arguments', () => {
    expect(fixture.version).toBe(2);
    const recall = fixture.tools.find((t: { name: string }) => t.name === 'memory_recall');
    expect(recall.input_schema.properties.source_id.type).toBe('string');
    expect(recall.input_schema.properties.source_ids.type).toBe('array');
    expect(recall.input_schema.required).toEqual(['query']);
    expect(fixture.memory_recall.scope_read.arguments).toEqual(['source_id', 'source_ids']);
    expect(fixture.memory_recall.scope_read.rule).toContain('never as the person');
    expect(fixture.transport.unknown_arguments).toContain('_meta.warnings');
    expect(fixture.actor.argument_rule).toContain('bound to a member');
    expect(fixture.errors.codes.map((c: { code: string }) => c.code)).toContain('permission_denied');
    const v1 = JSON.parse(readFileSync(QM_CONTRACT_PATH, 'utf8'));
    expect(fixture.wave_2).toEqual(v1.wave_2);
    const { scope_write: scopeWrite, ...memoryWrite } = fixture.memory_write;
    expect(memoryWrite).toEqual(v1.memory_write);
    const write = fixture.tools.find((t: { name: string }) => t.name === 'memory_write');
    expect(write.input_schema.properties.source_id.type).toBe('string');
    expect(write.input_schema.required).toEqual(v1.tools.find((t: { name: string }) => t.name === 'memory_write').input_schema.required);
    expect(scopeWrite.saved_as).toMatchObject({ page: 'memory/scope', visibility: 'world' });
    expect(scopeWrite.rule).toContain('attest_sources');
  });

  test('it says what an over-long query, an over-long recall question and an unattested acting_user get (GST-1304)', () => {
    expect(fixture.memory_recall.arguments_checked).toContain('a longer query is ranked on its first 2000 characters and never refused');
    const notes = Object.fromEntries(fixture.errors.codes.map((c: { code: string; note?: string }) => [c.code, c.note]));
    expect(notes.invalid_params).toContain('question_too_long');
    const reasons = fixture.errors.codes.find((c: { code: string }) => c.code === 'actor_not_attested').reasons;
    expect(reasons.find((r: { reason: string }) => r.reason === 'argument_without_attestation').fix).toContain('detail missing=');
  });
});

describe('QM memory-provider contract v3 (GST-1158 F1: personal tools, frozen result shapes, forget_fact)', () => {
  const fixture = JSON.parse(readFileSync(QM_CONTRACT_PATHS[3], 'utf8'));
  const v2 = JSON.parse(readFileSync(QM_CONTRACT_PATHS[2], 'utf8'));
  const personal = (name: string) => fixture.personal_tools.tools.find((t: { name: string }) => t.name === name);

  test('the committed fixture matches the live registry (regenerate with bun scripts/build-qm-memory-contract.ts)', () => {
    expect(readFileSync(QM_CONTRACT_PATHS[3], 'utf8')).toBe(renderQmMemoryContract(3));
  });

  test('it keeps everything v2 has; only the version, recall\'s fact rows, query_keep and the error list grow', () => {
    expect(fixture.version).toBe(3);
    for (const key of Object.keys(v2)) {
      if (key === 'version' || key === 'memory_recall' || key === 'errors' || key === 'tools') continue;
      expect(fixture[key]).toEqual(v2[key]);
    }
    const withoutKeep = (tools: Array<{ name: string; input_schema: { properties: Record<string, unknown> } }>) => tools.map(t => {
      const { query_keep: _keep, ...properties } = t.input_schema.properties;
      return { ...t, input_schema: { ...t.input_schema, properties } };
    });
    expect(withoutKeep(fixture.tools)).toEqual(v2.tools);
    const { structured_content: recallShape, arm: _arm, arguments_checked: _checked, ...recallRest } = fixture.memory_recall;
    const { structured_content: v2Shape, arguments_checked: _v2Checked, ...v2Rest } = v2.memory_recall;
    expect(recallRest).toEqual(v2Rest);
    const { query_truncated: _cut, ...recallShapeV2 } = recallShape;
    expect({ ...recallShapeV2, facts: [{ ...recallShape.facts[0], arm: undefined }] }).toEqual({ ...v2Shape, facts: [{ ...v2Shape.facts[0], arm: undefined }] });
    expect(fixture.errors.shape).toEqual(v2.errors.shape);
    for (const code of v2.errors.codes) expect(fixture.errors.codes.find((c: { code: string }) => c.code === code.code)).toBeDefined();
    expect(v2.personal_tools).toBeUndefined();
    expect(v2.memory_recall.structured_content.facts[0].arm).toBeUndefined();
  });

  test('memory_recall publishes query_keep head|tail and query_truncated only when it is sent (#8694); v2 has neither', () => {
    const recall = fixture.tools.find((t: { name: string }) => t.name === 'memory_recall');
    expect(recall.input_schema.properties.query_keep).toMatchObject({ type: 'string', enum: ['head', 'tail'] });
    expect(recall.input_schema.required).toEqual(['query']);
    expect(fixture.memory_recall.structured_content.query_truncated).toBe('boolean, only when the call sent query_keep');
    expect(fixture.memory_recall.arguments_checked).toContain('on its last 2000 with query_keep tail');
    expect(v2.tools.find((t: { name: string }) => t.name === 'memory_recall').input_schema.properties.query_keep).toBeUndefined();
    expect(v2.memory_recall.structured_content.query_truncated).toBeUndefined();
  });

  test('memory_recall fact rows carry their arm, own or ranked, and no score', () => {
    expect(fixture.memory_recall.structured_content.facts[0]).toEqual({ id: 'string', text: 'string', date: 'YYYY-MM-DD', kind: 'string', arm: '"own" | "ranked"' });
    expect(fixture.memory_recall.arm).toContain('ranked rows only');
    expect(JSON.stringify(fixture.memory_recall)).not.toContain('score');
  });

  test('it lists every personal tool, personal-only and opt-in, with the schema MCP serves', () => {
    const names = fixture.personal_tools.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([...QM_PERSONAL_OPS].sort());
    expect(names).toEqual(['context_pack', 'entity', 'find_experts', 'forget_fact', 'get_backlinks', 'get_page', 'get_timeline', 'get_write_request', 'query', 'volunteer_context', 'whois']);
    const served = buildToolDefs(operations.filter(o => QM_PERSONAL_OPS.has(o.name)));
    for (const tool of fixture.personal_tools.tools) {
      const def = served.find(d => d.name === tool.name)!;
      expect({ description: tool.description, ...tool.input_schema }).toEqual({ description: def.description, ...def.inputSchema });
      expect(tool.personal_only).toBe(true);
      expect(tool.result.structured_content).toBeDefined();
    }
    expect(fixture.actor.default_attest_ops).toEqual([...DEFAULT_ATTEST_OPS]);
    expect(fixture.actor.default_attest_ops).toEqual(['get_write_request', 'memory_recall', 'memory_write']);
    expect(fixture.personal_tools.opt_in).toContain('--attest-ops');
    expect(fixture.personal_tools.result_rule).toContain('must be ignored');
    for (const name of names) expect(fixture.actor.deferred_ops).not.toContain(name);
  });

  test('the frozen fields are present: every result names the fields QM decodes', () => {
    const fields = (name: string) => Object.keys(personal(name).result.structured_content);
    expect(fields('query')).toEqual(['results']);
    expect(Object.keys(personal('query').result.structured_content.results[0])).toEqual(['source_id', 'title', 'chunk_text', 'score']);
    expect(fields('get_page')).toEqual(['slug', 'source_id', 'type', 'title', 'revision']);
    expect(Object.keys(personal('get_timeline').result.structured_content.results[0])).toEqual(['id', 'date', 'summary', 'source', 'detail']);
    expect(Object.keys(personal('get_backlinks').result.structured_content.results[0])).toEqual(['from_slug', 'from_source_id', 'to_slug', 'to_source_id', 'link_type']);
    expect(Object.keys(personal('find_experts').result.structured_content.results[0])).toEqual(['slug', 'source_id', 'title', 'type', 'score']);
    expect(fields('whois')).toEqual(['query', 'query_kind', 'matches', 'ambiguous']);
    expect(fields('entity')).toEqual(['protocol_version', 'found']);
    expect(fields('context_pack')).toEqual(['protocol_version', 'entities', 'cards', 'open_threads', 'facts', 'entity_facts']);
    expect(personal('context_pack').result.content).toContain('text');
    expect(fields('volunteer_context')).toEqual(['pages', 'count', 'window_turns']);
    expect(fields('get_write_request')).toEqual(['request_id', 'state', 'retry_after_ms', 'operation', 'source_id', 'slug', 'created_at', 'updated_at']);
    expect(fields('forget_fact')).toEqual(['id', 'request_id', 'state']);
  });

  test('get_write_request freezes the write-request states, and an unknown state means unknown, not published', () => {
    const states = personal('get_write_request').result.states;
    expect(states.known).toEqual([...WRITE_REQUEST_STATES]);
    expect(states.known).toEqual(['queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled']);
    expect(states.terminal).toEqual(['committed', 'conflict', 'failed', 'cancelled']);
    expect(states.published).toBe('committed');
    expect(states.unknown).toContain('unknown, not published');
    expect(personal('get_write_request').result.structured_content.state).toBe(WRITE_REQUEST_STATES.map(s => '"' + s + '"').join(' | '));
    expect(personal('forget_fact').result.structured_content.state).toBe(personal('get_write_request').result.structured_content.state);
  });

  test('the personal tools add the refusal codes they answer with, each registered', () => {
    const codes = fixture.errors.codes.map((c: { code: string }) => c.code);
    for (const code of ['page_not_found', 'result_too_large']) expect(codes).toContain(code);
    for (const c of fixture.errors.codes) expect(CODES[c.code as keyof typeof CODES]).toBeDefined();
    expect(fixture.errors.applies_to).toContain('personal');
  });
});
