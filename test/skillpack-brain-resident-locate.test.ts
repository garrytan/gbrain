/**
 * Tests for src/core/skillpack/brain-resident-locate.ts — the source-scoped
 * discovery behind the list_brain_skillpack MCP tool and get_skill source_id.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runInitBrainPack } from '../src/core/skillpack/init-brain-pack.ts';
import {
  loadResidentPacksForServer,
  getResidentSkillDetail,
  deriveBrainId,
} from '../src/core/skillpack/brain-resident-locate.ts';
import type { OperationContext } from '../src/core/operations.ts';

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

describe('deriveBrainId', () => {
  test('prefers git remote; falls back to path hash', () => {
    expect(deriveBrainId('https://x/y.git', '/p')).toBe('git:https://x/y.git');
    expect(deriveBrainId(null, '/p')).toMatch(/^path:[0-9a-f]{16}$/);
  });
});
