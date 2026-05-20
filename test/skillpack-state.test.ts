/**
 * Tests for src/core/skillpack/state.ts — machine-owned trust store
 * at ~/.gbrain/skillpack-state.json (codex G1).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  SKILLPACK_STATE_SCHEMA_VERSION,
  SkillpackStateError,
  loadState,
  saveState,
  findEntry,
  upsertEntry,
  removeEntry,
  isAlreadyTrusted,
  type SkillpackStateEntry,
  type SkillpackState,
} from '../src/core/skillpack/state.ts';

function makeEntry(over: Partial<SkillpackStateEntry> = {}): SkillpackStateEntry {
  return {
    name: 'hackathon-evaluation',
    version: '0.1.0',
    author: 'Garry Tan',
    source: 'https://github.com/garrytan/skillpack-hackathon-evaluation',
    source_kind: 'git',
    pinned_commit: 'abc1234567890abcdef1234567890abcdef12345',
    tarball_sha256: null,
    tier: 'endorsed',
    scaffolded_at: '2026-05-18T20:00:00Z',
    workspace: '/Users/test/workspace',
    skill_slugs: ['skills/judge-submission'],
    ...over,
  };
}

let tmp: string;
let statePath: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'state-test-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  statePath = join(tmp, `state-${Date.now()}-${Math.random()}.json`);
});

describe('loadState — cold start + happy path', () => {
  test('returns empty state when file does not exist', () => {
    const s = loadState({ statePath });
    expect(s.schema_version).toBe(SKILLPACK_STATE_SCHEMA_VERSION);
    expect(s.packs).toEqual([]);
  });

  test('round-trips through save + load', () => {
    const entry = makeEntry();
    saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [entry] }, { statePath });
    const loaded = loadState({ statePath });
    expect(loaded.packs).toHaveLength(1);
    expect(loaded.packs[0]?.name).toBe('hackathon-evaluation');
    expect(loaded.packs[0]?.pinned_commit).toBe('abc1234567890abcdef1234567890abcdef12345');
  });
});

describe('loadState — error paths', () => {
  test('throws state_malformed_json on invalid JSON', () => {
    writeFileSync(statePath, '{ not json');
    try {
      loadState({ statePath });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackStateError).code).toBe('state_malformed_json');
    }
  });

  test('throws state_malformed_json on non-object top level', () => {
    writeFileSync(statePath, '[]');
    try {
      loadState({ statePath });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackStateError).code).toBe('state_malformed_json');
    }
  });

  test('throws state_schema_unknown on mismatched schema version', () => {
    writeFileSync(statePath, JSON.stringify({ schema_version: 'gbrain-skillpack-state-v99', packs: [] }));
    try {
      loadState({ statePath });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackStateError).code).toBe('state_schema_unknown');
    }
  });

  test('throws state_malformed_json when packs is not an array', () => {
    writeFileSync(
      statePath,
      JSON.stringify({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: {} }),
    );
    try {
      loadState({ statePath });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as SkillpackStateError).code).toBe('state_malformed_json');
    }
  });
});

describe('saveState — atomic write', () => {
  test('writes file via .tmp then rename (no .tmp left behind on success)', () => {
    const entry = makeEntry();
    saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [entry] }, { statePath });
    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(statePath + '.tmp')).toBe(false);
  });

  test('writes pretty-printed JSON with trailing newline', () => {
    saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [makeEntry()] }, { statePath });
    const content = readFileSync(statePath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    // Indented (looking for the 2-space indent before "packs")
    expect(content).toContain('  "packs": [');
  });
});

describe('findEntry / upsertEntry / removeEntry', () => {
  test('findEntry returns the matching entry', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ name: 'one' }), makeEntry({ name: 'two' })],
    };
    expect(findEntry(state, 'one')?.name).toBe('one');
    expect(findEntry(state, 'two')?.name).toBe('two');
    expect(findEntry(state, 'three')).toBeUndefined();
  });

  test('upsertEntry replaces an existing entry by name', () => {
    let state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ name: 'one', version: '0.1.0' })],
    };
    state = upsertEntry(state, makeEntry({ name: 'one', version: '0.2.0' }));
    expect(state.packs).toHaveLength(1);
    expect(state.packs[0]?.version).toBe('0.2.0');
  });

  test('upsertEntry appends a new entry when name is unique', () => {
    let state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ name: 'one' })],
    };
    state = upsertEntry(state, makeEntry({ name: 'two' }));
    expect(state.packs).toHaveLength(2);
    expect(state.packs.map((p) => p.name).sort()).toEqual(['one', 'two']);
  });

  test('removeEntry drops the matching entry; no-op when name absent', () => {
    let state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ name: 'one' }), makeEntry({ name: 'two' })],
    };
    state = removeEntry(state, 'one');
    expect(state.packs.map((p) => p.name)).toEqual(['two']);

    state = removeEntry(state, 'nonexistent');
    expect(state.packs.map((p) => p.name)).toEqual(['two']);
  });
});

describe('isAlreadyTrusted — codex G4 TOFU prompt-skip logic', () => {
  test('returns false when pack is not yet installed', () => {
    const state: SkillpackState = { schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [] };
    expect(
      isAlreadyTrusted(state, {
        name: 'foo',
        author: 'a',
        pinned_commit: 'abc',
        tarball_sha256: null,
      }),
    ).toBe(false);
  });

  test('returns true when name + author + pinned_commit all match', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ pinned_commit: 'abc' })],
    };
    expect(
      isAlreadyTrusted(state, {
        name: 'hackathon-evaluation',
        author: 'Garry Tan',
        pinned_commit: 'abc',
        tarball_sha256: null,
      }),
    ).toBe(true);
  });

  test('returns false when author differs (transfer-attack defense)', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ author: 'Garry Tan', pinned_commit: 'abc' })],
    };
    expect(
      isAlreadyTrusted(state, {
        name: 'hackathon-evaluation',
        author: 'Different Author',
        pinned_commit: 'abc',
        tarball_sha256: null,
      }),
    ).toBe(false);
  });

  test('returns false when pinned_commit differs', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ pinned_commit: 'abc' })],
    };
    expect(
      isAlreadyTrusted(state, {
        name: 'hackathon-evaluation',
        author: 'Garry Tan',
        pinned_commit: 'def',
        tarball_sha256: null,
      }),
    ).toBe(false);
  });

  test('matches on tarball_sha256 for source_kind=tarball', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ pinned_commit: null, tarball_sha256: 'deadbeef' })],
    };
    expect(
      isAlreadyTrusted(state, {
        name: 'hackathon-evaluation',
        author: 'Garry Tan',
        pinned_commit: null,
        tarball_sha256: 'deadbeef',
      }),
    ).toBe(true);
  });

  test('returns false for local-path source even when name + author match (no identity to pin)', () => {
    const state: SkillpackState = {
      schema_version: SKILLPACK_STATE_SCHEMA_VERSION,
      packs: [makeEntry({ source_kind: 'local', pinned_commit: null, tarball_sha256: null })],
    };
    expect(
      isAlreadyTrusted(state, {
        name: 'hackathon-evaluation',
        author: 'Garry Tan',
        pinned_commit: null,
        tarball_sha256: null,
      }),
    ).toBe(false);
  });
});
