import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { operations } from '../src/core/operations.ts';
import { createMcpToolCatalogProvider } from '../src/mcp/server.ts';
import {
  CORE_TOOLS,
  effectiveToolTier,
  isToolVisibleAtTier,
  resolveAllowedTiers,
} from '../src/mcp/tool-tiers.ts';

// Workstream C1 part 2: tiered tool catalog. Pins the tier classification + the default
// stdio filter so the daily-driver tools stay visible and control-plane tools stay hidden
// by default; named MCP dispatch must honor the same tier gate.

describe('tiered tool catalog (C1 part 2)', () => {
  test('every operation resolves to a valid tier', () => {
    for (const op of operations) {
      expect(['core', 'extended', 'admin']).toContain(effectiveToolTier(op));
    }
  });

  test('daily-driver ops are core; control-plane ops are admin', () => {
    const byName = new Map(operations.map(op => [op.name, op]));
    for (const name of CORE_TOOLS) {
      const op = byName.get(name);
      if (op) expect(effectiveToolTier(op)).toBe('core');
    }
    for (const name of [
      'apply_memory_redaction_plan',
      'create_memory_session',
      'upsert_memory_realm',
      'run_dream_cycle_maintenance',
      'request_raw_source_chunks',
      'register_source',
      'list_sources',
      'get_source',
      'list_source_items',
      'capture_agent_session_memory',
      'plan_agent_session_activation',
    ]) {
      const op = byName.get(name);
      if (op) expect(effectiveToolTier(op)).toBe('admin');
    }
  });

  test('an explicit op.tier overrides the name classifier', () => {
    expect(effectiveToolTier({ name: 'apply_memory_redaction_plan', tier: 'core' } as never)).toBe('core');
    expect(effectiveToolTier({ name: 'retrieve_context', tier: 'admin' } as never)).toBe('admin');
  });

  test('resolveAllowedTiers honors default, all, and explicit selections', () => {
    expect([...resolveAllowedTiers()].sort()).toEqual(['core', 'extended']);
    expect([...resolveAllowedTiers('core+extended')].sort()).toEqual(['core', 'extended']);
    expect([...resolveAllowedTiers('all')].sort()).toEqual(['admin', 'core', 'extended']);
    expect([...resolveAllowedTiers('core')]).toEqual(['core']);
    expect([...resolveAllowedTiers('core,admin')].sort()).toEqual(['admin', 'core']);
  });

  test('default stdio catalog hides admin ops; =all restores the full surface', () => {
    const defaultTier = createMcpToolCatalogProvider(operations, { allowedTiers: resolveAllowedTiers() });
    const allTier = createMcpToolCatalogProvider(operations, { allowedTiers: resolveAllowedTiers('all') });

    const defaultNames = new Set(defaultTier.getTools().map(tool => tool.name));
    const allNames = new Set(allTier.getTools().map(tool => tool.name));

    expect(defaultNames.has('retrieve_context')).toBe(true);
    expect(defaultNames.has('put_page')).toBe(true);
    expect(defaultNames.has('apply_memory_redaction_plan')).toBe(false);
    expect(allNames.has('apply_memory_redaction_plan')).toBe(true);
    expect(allNames.size).toBe(operations.length);
    expect(defaultNames.size).toBeLessThan(allNames.size);
  });

  test('isToolVisibleAtTier gates an admin op by the allowed set', () => {
    const admin = operations.find(op => effectiveToolTier(op) === 'admin');
    expect(admin).toBeDefined();
    if (admin) {
      expect(isToolVisibleAtTier(admin, resolveAllowedTiers())).toBe(false);
      expect(isToolVisibleAtTier(admin, resolveAllowedTiers('all'))).toBe(true);
    }
  });

  test('MCP named dispatch uses the same tier gate as the catalog', () => {
    const source = readFileSync(new URL('../src/mcp/server.ts', import.meta.url), 'utf-8');

    expect(source).toContain('!isToolVisibleAtTier(op, allowedTiers)');
  });
});
