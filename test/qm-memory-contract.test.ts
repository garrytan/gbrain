/**
 * GST-359 D: the QM memory-provider contract fixtures (docs/contracts/qm-memory-provider/v1.json and v2.json).
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
import { unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';

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

  test('the tool schemas are the ones MCP serves', () => {
    const served = buildToolDefs(operations.filter(o => o.name === 'memory_recall' || o.name === 'memory_write'));
    for (const tool of fixture.tools) {
      const def = served.find(d => d.name === tool.name)!;
      expect({ description: tool.description, ...tool.input_schema }).toEqual({ description: def.description, ...def.inputSchema });
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
