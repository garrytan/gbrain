/**
 * personas.ts — persona curation over skills/plugin-lanes.json.
 *
 * Hermetic fixture root for every validation rule (the generator's negative
 * fixtures re-prove the same rules THROUGH the subprocess seam — one
 * implementation, two consumers), plus real-repo pins for the two launch
 * personas.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  PersonaError,
  computeLaneSet,
  loadPersonas,
  resolvePersonaSlugs,
  validateSlugsAgainstLane,
} from '../src/core/skillpack/personas.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REASON = 'a fixture reason long enough to pass';

function fixtureRoot(overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'gb-personas-'));
  cleanups.push(root);
  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0.0', skills: ['skills/alpha', 'skills/gamma'], shared_deps: [] }),
  );
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'plugin-lanes.json'),
    JSON.stringify({
      starter_policy: 'fixture',
      additions: { beta: REASON },
      base_exclusions: { gamma: 'gbrain-repo development skill — fixture exclusion record' },
      not_added: {},
      personas: {
        tester: {
          description: 'a fixture persona description',
          plugin_name: 'gbrain-tester',
          skills: { alpha: REASON, beta: REASON },
        },
      },
      starter_gaps: {},
      ...overrides,
    }),
  );
  return root;
}

describe('lane algebra', () => {
  test('laneSet = (openclaw ∖ base_exclusions) ∪ additions', () => {
    const root = fixtureRoot();
    expect([...computeLaneSet(root)].sort()).toEqual(['alpha', 'beta']);
  });
});

describe('loadPersonas', () => {
  test('valid block loads; absent block is valid and empty', () => {
    const { personas, laneSet } = loadPersonas(fixtureRoot());
    expect(Object.keys(personas)).toEqual(['tester']);
    expect(personas.tester.plugin_name).toBe('gbrain-tester');
    expect(laneSet.has('alpha')).toBe(true);

    const bare = fixtureRoot({ personas: undefined });
    expect(loadPersonas(bare).personas).toEqual({});
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    [
      'reserved name all',
      { personas: { all: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: { alpha: REASON } } } },
      'reserved name',
    ],
    [
      'non-kebab name',
      { personas: { NotKebab: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: { alpha: REASON } } } },
      'kebab-case',
    ],
    [
      'plugin_name without the gbrain- prefix',
      { personas: { tester: { description: 'a fixture persona description', plugin_name: 'coding', skills: { alpha: REASON } } } },
      'plugin_name',
    ],
    [
      'duplicate plugin_name',
      {
        personas: {
          one: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: { alpha: REASON } },
          two: { description: 'another fixture persona text', plugin_name: 'gbrain-x', skills: { alpha: REASON } },
        },
      },
      'already used by persona',
    ],
    [
      'short skill reason',
      { personas: { tester: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: { alpha: 'short' } } } },
      'recorded reason of at least',
    ],
    [
      'empty skills',
      { personas: { tester: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: {} } } },
      'non-empty object',
    ],
    [
      'slug outside the lane (base-excluded gamma)',
      { personas: { tester: { description: 'a fixture persona description', plugin_name: 'gbrain-x', skills: { gamma: REASON } } } },
      'not in the plugin lane set',
    ],
  ];
  for (const [label, overrides, needle] of bad) {
    test(`fail-loud: ${label}`, () => {
      const root = fixtureRoot(overrides);
      expect(() => loadPersonas(root)).toThrow(PersonaError);
      try {
        loadPersonas(root);
      } catch (err) {
        expect((err as Error).message).toContain(needle);
      }
    });
  }
});

describe('resolvePersonaSlugs', () => {
  test('persona → its sorted slugs; all → the full lane set', () => {
    const root = fixtureRoot();
    expect(resolvePersonaSlugs(root, 'tester')).toEqual(['alpha', 'beta']);
    expect(resolvePersonaSlugs(root, 'all')).toEqual(['alpha', 'beta']);
  });

  test('unknown persona fails naming the valid choices', () => {
    const root = fixtureRoot();
    try {
      resolvePersonaSlugs(root, 'nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PersonaError);
      expect((err as PersonaError).code).toBe('persona_unknown');
      expect((err as Error).message).toContain('tester');
    }
  });
});

describe('validateSlugsAgainstLane', () => {
  test('lane members pass; base-excluded slugs are refused WITH the recorded reason', () => {
    const root = fixtureRoot();
    expect(() => validateSlugsAgainstLane(root, ['alpha', 'beta'])).not.toThrow();
    try {
      validateSlugsAgainstLane(root, ['gamma']);
      expect.unreachable();
    } catch (err) {
      expect((err as PersonaError).code).toBe('slug_not_in_lane');
      expect((err as Error).message).toContain('fixture exclusion record');
    }
    expect(() => validateSlugsAgainstLane(root, ['zzz'])).toThrow(PersonaError);
  });
});

describe('real repo personas (the launch curation)', () => {
  test('coding-agent + daily-driver exist and resolve real rosters', () => {
    const { personas } = loadPersonas(REPO_ROOT);
    expect(Object.keys(personas).sort()).toEqual(['coding-agent', 'daily-driver']);
    expect(personas['coding-agent'].plugin_name).toBe('gbrain-coding');
    expect(personas['daily-driver'].plugin_name).toBe('gbrain-daily');
    const coding = resolvePersonaSlugs(REPO_ROOT, 'coding-agent');
    const daily = resolvePersonaSlugs(REPO_ROOT, 'daily-driver');
    expect(coding.length).toBeGreaterThanOrEqual(15);
    expect(daily.length).toBeGreaterThanOrEqual(15);
    // The lane-exclusion rationale that shaped the roster: `testing` is
    // repo-dev-only and can never join a persona.
    expect(coding).not.toContain('testing');
    expect(() => validateSlugsAgainstLane(REPO_ROOT, ['testing'])).toThrow(PersonaError);
  });
});
