/**
 * Tests for src/core/skillpack/brain-resident-locate.ts — the source-scoped
 * discovery behind the list_brain_skillpack MCP tool and get_skill source_id.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runInitBrainPack } from '../src/core/skillpack/init-brain-pack.ts';
import {
  loadResidentPacksForServer,
  getResidentSkillDetail,
  deriveBrainId,
} from '../src/core/skillpack/brain-resident-locate.ts';
import { OperationError, type OperationContext } from '../src/core/operations.ts';

let root: string;
let packDir: string;
let plainDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-brl-'));
  packDir = join(root, 'pack-source');
  plainDir = join(root, 'plain-source');
  runInitBrainPack({ targetDir: packDir, name: 'deal-brain', firstSkillSlug: 'diligence', schemaPack: 'gbrain-base' });
  // plainDir: a source with no skillpack at all
  mkdtempSync(join(tmpdir(), 'noop-')); // touch tmp to avoid lints; plainDir stays empty
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Minimal fake engine: only executeRaw (sources SELECT) + getConfig are used. */
function fakeEngine(sources: Array<{ id: string; local_path: string | null; config?: Record<string, unknown> }>, cfg: Record<string, string> = {}) {
  return {
    executeRaw: async () =>
      sources.map((s) => ({
        id: s.id,
        name: s.id,
        local_path: s.local_path,
        last_commit: null,
        last_sync_at: null,
        config: s.config ?? {},
        created_at: new Date(),
        archived: false,
      })),
    getConfig: async (k: string) => cfg[k] ?? null,
  } as unknown as OperationContext['engine'];
}

function ctxFor(engine: OperationContext['engine'], over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    ...over,
  } as OperationContext;
}

describe('loadResidentPacksForServer', () => {
  test('finds brain_resident packs, skips plain sources', async () => {
    const engine = fakeEngine([
      { id: 'default', local_path: packDir, config: { remote_url: 'https://github.com/u/deal-brain.git' } },
      { id: 'plain', local_path: plainDir },
    ]);
    const result = await loadResidentPacksForServer(ctxFor(engine, { remote: false }));
    expect(result.packs).toHaveLength(1);
    const p = result.packs[0]!;
    expect(p.name).toBe('deal-brain');
    expect(p.source_id).toBe('default');
    expect(p.skills.map((s) => s.slug)).toEqual(['diligence']);
    // git remote → scaffold_spec is the git spec, NEVER a server FS path (#6)
    expect(p.scaffold_spec).toBe('https://github.com/u/deal-brain.git');
    expect(p.scaffold_spec).not.toContain(packDir);
  });

  test('computes schema_pack_match server-side against per-source config (#7)', async () => {
    const engine = fakeEngine(
      [{ id: 'default', local_path: packDir }],
      { 'schema_pack.source.default': 'gbrain-other' },
    );
    const result = await loadResidentPacksForServer(ctxFor(engine, { remote: false }));
    expect(result.packs[0]!.active_schema_pack).toBe('gbrain-other');
    expect(result.packs[0]!.schema_pack_match).toBe(false);
  });

  test('local-only source (no git remote) → scaffold_spec null', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    const result = await loadResidentPacksForServer(ctxFor(engine, { remote: false }));
    expect(result.packs[0]!.scaffold_spec).toBeNull();
  });

  test('source scoping: out-of-scope source is excluded', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    // caller scoped to a different source id → no packs
    const ctx = ctxFor(engine, { auth: { allowedSources: ['other'] } as OperationContext['auth'] });
    const result = await loadResidentPacksForServer(ctx);
    expect(result.packs).toHaveLength(0);
  });
});

describe('getResidentSkillDetail', () => {
  test('returns the SKILL.md body for an in-pack slug', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    const detail = await getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', 'diligence');
    expect(detail.pack_name).toBe('deal-brain');
    expect(detail.slug).toBe('diligence');
    expect(detail.body).toContain('# diligence');
  });

  test('throws not_found for an unknown slug', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    await expect(
      getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', 'nope'),
    ).rejects.toThrow();
  });
});

/** Await a rejection and pin its OperationError code. */
async function expectOpError(p: Promise<unknown>, code: string): Promise<OperationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OperationError);
    expect((e as OperationError).code).toBe(code);
    return e as OperationError;
  }
  throw new Error(`expected OperationError(${code}) but the call resolved`);
}

/** Engine that counts calls — proves a rejection fired before any engine (and
 *  therefore any source-path/FS) access. loadAllSources only uses executeRaw. */
function countingEngine() {
  const calls = { executeRaw: 0, getConfig: 0 };
  const engine = {
    executeRaw: async () => {
      calls.executeRaw += 1;
      return [];
    },
    getConfig: async () => {
      calls.getConfig += 1;
      return null;
    },
  } as unknown as OperationContext['engine'];
  return { engine, calls };
}

describe('getResidentSkillDetail — slug shape gate (pre-FS, pre-engine)', () => {
  // The gate is /^[a-z0-9][a-z0-9-]{0,63}$/ at brain-resident-locate.ts — it
  // fires before sourceScopeOpts, loadAllSources, and every fs call, so a
  // traversal-shaped slug never even enumerates sources.
  for (const bad of ['../x', 'a/../b', '']) {
    test(`rejects ${JSON.stringify(bad)} with invalid_params, zero engine calls`, async () => {
      const { engine, calls } = countingEngine();
      await expectOpError(
        getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', bad),
        'invalid_params',
      );
      expect(calls.executeRaw).toBe(0);
      expect(calls.getConfig).toBe(0);
    });
  }

  test('rejects an over-long slug (65 chars > the 64-char regex cap) pre-engine', async () => {
    const { engine, calls } = countingEngine();
    await expectOpError(
      getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', 'a'.repeat(65)),
      'invalid_params',
    );
    expect(calls.executeRaw).toBe(0);
  });

  test('boundary: a 64-char slug passes the shape gate (fails later as not_found)', async () => {
    // Anti-vacuity for the length pin: 64 chars is WITHIN the regex cap, so the
    // failure is the in-pack lookup (not_found), not the shape gate.
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    await expectOpError(
      getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', 'a'.repeat(64)),
      'not_found',
    );
  });
});

describe('getResidentSkillDetail — source scoping (anti-enumeration)', () => {
  test('federated-array scope pointing away from the source → not_found', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    const ctx = ctxFor(engine, { auth: { allowedSources: ['other'] } as OperationContext['auth'] });
    await expectOpError(getResidentSkillDetail(ctx, 'default', 'diligence'), 'not_found');
  });

  test('scalar ctx.sourceId pointing away from the source → not_found', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    const ctx = ctxFor(engine, { sourceId: 'other' });
    await expectOpError(getResidentSkillDetail(ctx, 'default', 'diligence'), 'not_found');
  });

  test('anti-vacuity: the same skill IS fetchable by in-scope callers', async () => {
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    // federated in-scope
    const fed = await getResidentSkillDetail(
      ctxFor(engine, { auth: { allowedSources: ['other', 'default'] } as OperationContext['auth'] }),
      'default',
      'diligence',
    );
    expect(fed.body).toContain('# diligence');
    // scalar in-scope
    const scalar = await getResidentSkillDetail(ctxFor(engine, { sourceId: 'default' }), 'default', 'diligence');
    expect(scalar.pack_name).toBe('deal-brain');
  });
});

describe('getResidentSkillDetail — symlink escape confinement', () => {
  test('a skill directory symlinked outside the pack root → storage_error', async () => {
    // Mirror test/skill-catalog-security.test.ts: point the manifest-listed
    // skill dir at a directory OUTSIDE the pack root. realpath containment at
    // brain-resident-locate.ts must refuse to serve the out-of-root SKILL.md.
    const outside = join(root, 'outside-skill');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: sneaky\n---\n\nTOP SECRET OUTSIDE PACK\n');
    const skillDir = join(packDir, 'skills', 'diligence');
    rmSync(skillDir, { recursive: true, force: true });
    try {
      symlinkSync(outside, skillDir, 'dir');
    } catch {
      return; // symlink unsupported on this platform — skip
    }
    const engine = fakeEngine([{ id: 'default', local_path: packDir }]);
    const err = await expectOpError(
      getResidentSkillDetail(ctxFor(engine, { remote: false }), 'default', 'diligence'),
      'storage_error',
    );
    expect(err.message).toContain('escaped');
  });
});

describe('deriveBrainId', () => {
  test('prefers git remote; falls back to path hash', () => {
    expect(deriveBrainId('https://x/y.git', '/p')).toBe('git:https://x/y.git');
    expect(deriveBrainId(null, '/p')).toMatch(/^path:[0-9a-f]{16}$/);
  });
});
