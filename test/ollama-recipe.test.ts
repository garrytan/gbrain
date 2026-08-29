/**
 * Ollama recipe — chat touchpoint shape.
 *
 * The extract-atoms phase registers config-selected chat models through the
 * gateway's extended-model path so local/user-managed providers (Ollama) can
 * serve the phase without hosted API keys. That wiring presumes the recipe
 * DECLARES a chat touchpoint with a non-empty allowlist — assertTouchpoint
 * rejects a provider whose touchpoint is missing, and an empty models list
 * would leave no default-eligible model at all.
 */

import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../src/core/ai/recipes/index.ts';

describe('Ollama recipe — chat touchpoint', () => {
  test('declares a chat touchpoint', () => {
    const r = getRecipe('ollama');
    expect(r).toBeDefined();
    expect(r!.touchpoints.chat).toBeDefined();
  });

  test('chat models list is non-empty and every entry is a non-empty string', () => {
    const m = getRecipe('ollama')!.touchpoints.chat!.models;
    expect(Array.isArray(m)).toBe(true);
    expect(m.length).toBeGreaterThan(0);
    for (const model of m) {
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    }
  });

  test('local chat models advertise no hosted-only capabilities', () => {
    // Local Ollama chat serves plain completions; the gateway must not route
    // tool-use / subagent / structured-output work here.
    const tp = getRecipe('ollama')!.touchpoints.chat!;
    expect(tp.supports_tools).toBe(false);
    expect(tp.supports_subagent_loop).toBe(false);
    expect(tp.supports_structured_outputs).toBe(false);
  });
});
