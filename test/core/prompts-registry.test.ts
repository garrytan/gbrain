/**
 * Unit tests for the prompt registry + resolve layer
 * (src/core/prompts/registry.ts, src/core/prompts/resolve.ts) and the
 * admin control layer (src/core/prompts/admin.ts).
 *
 * Engine is faked with a minimal getConfig/setConfig/unsetConfig KV map —
 * no DB, no network.
 */

import { describe, test, expect } from 'bun:test';
import { PROMPT_REGISTRY, getPromptDef } from '../../src/core/prompts/registry.ts';
import {
  resolvePromptText,
  getPromptOverride,
  promptConfigKey,
  effectivePromptVersion,
  extractPlaceholders,
  missingPlaceholders,
} from '../../src/core/prompts/resolve.ts';
import { listPrompts, setPromptOverride, resetPromptOverride, PromptAdminError, type PromptStatus } from '../../src/core/prompts/admin.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

function fakeEngine(initial: Record<string, string> = {}): BrainEngine {
  const kv = new Map(Object.entries(initial));
  return {
    getConfig: async (key: string) => kv.get(key) ?? null,
    setConfig: async (key: string, value: string) => { kv.set(key, value); },
    unsetConfig: async (key: string) => (kv.delete(key) ? 1 : 0),
  } as unknown as BrainEngine;
}

describe('PROMPT_REGISTRY invariants', () => {
  test('ids are unique', () => {
    const ids = PROMPT_REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every editable prompt has non-empty default text', () => {
    for (const def of PROMPT_REGISTRY.filter((p) => p.editable)) {
      expect(def.defaultText.trim().length).toBeGreaterThan(0);
    }
  });

  test('declared required placeholders actually appear in the default text', () => {
    for (const def of PROMPT_REGISTRY.filter((p) => p.editable)) {
      expect(missingPlaceholders(def.defaultText, def.requiredPlaceholders)).toEqual([]);
    }
  });

  test('getPromptDef finds known ids and rejects unknown', () => {
    expect(getPromptDef('facts.extractor')?.editable).toBe(true);
    expect(getPromptDef('nope.nothing')).toBeUndefined();
  });
});

describe('resolvePromptText', () => {
  test('returns default without engine', async () => {
    expect(await resolvePromptText(null, 'facts.extractor', 'DEFAULT')).toBe('DEFAULT');
  });

  test('returns default when no override set', async () => {
    expect(await resolvePromptText(fakeEngine(), 'facts.extractor', 'DEFAULT')).toBe('DEFAULT');
  });

  test('returns override when set', async () => {
    const engine = fakeEngine({ [promptConfigKey('facts.extractor')]: 'OVERRIDE' });
    expect(await resolvePromptText(engine, 'facts.extractor', 'DEFAULT')).toBe('OVERRIDE');
  });

  test('whitespace-only override is treated as unset', async () => {
    const engine = fakeEngine({ [promptConfigKey('facts.extractor')]: '   \n ' });
    expect(await resolvePromptText(engine, 'facts.extractor', 'DEFAULT')).toBe('DEFAULT');
  });

  test('a throwing engine falls back to default', async () => {
    const engine = { getConfig: async () => { throw new Error('db down'); } } as unknown as BrainEngine;
    expect(await resolvePromptText(engine, 'facts.extractor', 'DEFAULT')).toBe('DEFAULT');
    expect(await getPromptOverride(engine, 'facts.extractor')).toBeNull();
  });
});

describe('effectivePromptVersion', () => {
  test('unchanged text keeps the base version', () => {
    expect(effectivePromptVersion('v1', 'same', 'same')).toBe('v1');
  });

  test('overridden text appends a stable digest', () => {
    const a = effectivePromptVersion('v1', 'default', 'changed');
    const b = effectivePromptVersion('v1', 'default', 'changed');
    expect(a).toBe(b);
    expect(a).toMatch(/^v1\+[0-9a-f]{8}$/);
    expect(effectivePromptVersion('v1', 'default', 'other')).not.toBe(a);
  });
});

describe('placeholder helpers', () => {
  test('extracts {UPPER_SNAKE} tokens only', () => {
    expect(extractPlaceholders('a {FOO} b {BAR_2} c {lower} {X}')).toEqual(['FOO', 'BAR_2', 'X']);
  });
});

describe('prompt admin control layer', () => {
  test('listPrompts reports override state', async () => {
    const engine = fakeEngine({ [promptConfigKey('facts.extractor')]: 'CUSTOM' });
    const list = await listPrompts(engine);
    const extractor = list.find((p: PromptStatus) => p.id === 'facts.extractor')!;
    expect(extractor.overridden).toBe(true);
    expect(extractor.override_text).toBe('CUSTOM');
    const other = list.find((p: PromptStatus) => p.id === 'cycle.grade_takes')!;
    expect(other.overridden).toBe(false);
  });

  test('setPromptOverride persists and returns fresh status', async () => {
    const engine = fakeEngine();
    const status = await setPromptOverride(engine, 'facts.extractor', 'NEW PROMPT');
    expect(status.overridden).toBe(true);
    expect(await engine.getConfig(promptConfigKey('facts.extractor'))).toBe('NEW PROMPT');
  });

  test('saving the default verbatim clears the override', async () => {
    const def = getPromptDef('facts.extractor')!;
    const engine = fakeEngine({ [promptConfigKey('facts.extractor')]: 'OLD' });
    const status = await setPromptOverride(engine, 'facts.extractor', def.defaultText);
    expect(status.overridden).toBe(false);
    expect(await engine.getConfig(promptConfigKey('facts.extractor'))).toBeNull();
  });

  test('rejects overrides that drop required placeholders', async () => {
    const engine = fakeEngine();
    await expect(setPromptOverride(engine, 'cycle.grade_takes', 'no placeholders here'))
      .rejects.toThrow(/missing_placeholders/);
    expect(await engine.getConfig(promptConfigKey('cycle.grade_takes'))).toBeNull();
  });

  test('rejects unknown ids and read-only prompts', async () => {
    const engine = fakeEngine();
    await expect(setPromptOverride(engine, 'nope', 'x')).rejects.toBeInstanceOf(PromptAdminError);
    await expect(setPromptOverride(engine, 'pages.synopsis', 'x')).rejects.toThrow('prompt_not_editable');
  });

  test('digest-suffixed effective_version appears for version-cached prompts', async () => {
    const def = getPromptDef('cycle.propose_takes')!;
    const engine = fakeEngine();
    const custom = `${def.defaultText}\n(extra rule)`;
    const status = await setPromptOverride(engine, 'cycle.propose_takes', custom);
    expect(status.effective_version).toMatch(new RegExp(`^${def.baseVersion}\\+[0-9a-f]{8}$`.replace(/\./g, '\\.')));
  });

  test('resetPromptOverride restores default', async () => {
    const engine = fakeEngine({ [promptConfigKey('facts.extractor')]: 'CUSTOM' });
    const status = await resetPromptOverride(engine, 'facts.extractor');
    expect(status.overridden).toBe(false);
    expect(await engine.getConfig(promptConfigKey('facts.extractor'))).toBeNull();
  });
});
