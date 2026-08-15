/**
 * personas.test.mjs — registry shape regressions.
 *
 * Verifies the persona registry surface that downstream tooling depends on:
 *   - PERSONAS has the expected keys
 *   - getPersona() returns the right object for known/unknown inputs
 *   - listPersonas() returns the public-facing shape
 *
 * These are hermetic — no fs, no network, no env vars.
 */

import { describe, expect, it } from 'vitest';
import { PERSONAS, getPersona, listPersonas, buildSharedContext } from '../../code/lib/personas/personas.mjs';
import { MARS } from '../../code/lib/personas/mars.mjs';
import { VENUS } from '../../code/lib/personas/venus.mjs';

describe('PERSONAS registry', () => {
  it('exposes mars and venus keys', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual(['mars', 'venus']);
  });

  it('mars entry === MARS export', () => {
    expect(PERSONAS.mars).toBe(MARS);
  });

  it('venus entry === VENUS export', () => {
    expect(PERSONAS.venus).toBe(VENUS);
  });

  it('every persona has the expected fields', () => {
    for (const p of Object.values(PERSONAS)) {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('voice');
      expect(p).toHaveProperty('emoji');
      expect(p).toHaveProperty('description');
      expect(p).toHaveProperty('prompt');
      expect(typeof p.prompt).toBe('string');
      expect(p.prompt.length).toBeGreaterThan(100);
    }
  });
});

describe('getPersona()', () => {
  it('returns MARS for "mars"', () => {
    expect(getPersona('mars')).toBe(MARS);
  });

  it('returns VENUS for "venus"', () => {
    expect(getPersona('venus')).toBe(VENUS);
  });

  it('is case-insensitive', () => {
    expect(getPersona('MARS')).toBe(MARS);
    expect(getPersona('Venus')).toBe(VENUS);
    expect(getPersona('  mars  '.trim())).toBe(MARS);
  });

  it('falls back to VENUS for unknown', () => {
    expect(getPersona('unknown')).toBe(VENUS);
    expect(getPersona('')).toBe(VENUS);
    expect(getPersona(undefined)).toBe(VENUS);
    expect(getPersona(null)).toBe(VENUS);
  });
});

describe('listPersonas()', () => {
  it('returns one entry per registered persona', () => {
    const list = listPersonas();
    expect(list).toHaveLength(Object.keys(PERSONAS).length);
  });

  it('each entry has the public shape', () => {
    for (const entry of listPersonas()) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('voice');
      expect(entry).toHaveProperty('emoji');
      expect(entry).toHaveProperty('description');
      // Public listing must NOT expose the prompt (avoids leaking persona
      // internals via a directory endpoint).
      expect(entry).not.toHaveProperty('prompt');
    }
  });
});

describe('buildSharedContext()', () => {
  it('returns empty string with no opts', () => {
    expect(buildSharedContext()).toBe('');
    expect(buildSharedContext({})).toBe('');
  });

  it('includes dateTime when provided', () => {
    const ctx = buildSharedContext({ dateTime: '2026-05-17 10:00' });
    expect(ctx).toContain('2026-05-17');
  });

  it('includes identity when authenticated and identity set', () => {
    const ctx = buildSharedContext({ authenticated: true, identity: 'operator' });
    expect(ctx).toContain('operator');
  });

  it('does NOT include identity when authenticated but no identity', () => {
    const ctx = buildSharedContext({ authenticated: true });
    expect(ctx).not.toMatch(/verified as/);
  });

  it('does NOT include identity when unauthenticated', () => {
    const ctx = buildSharedContext({ authenticated: false, identity: 'operator' });
    expect(ctx).not.toMatch(/verified as/);
  });
});
