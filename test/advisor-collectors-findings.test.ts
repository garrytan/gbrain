/**
 * test/advisor-collectors-findings.test.ts — the two advisor collectors with
 * no direct finding-shape coverage:
 *
 *   - collect-migration.ts: the ONLY collector that can emit `critical`.
 *     test/advisor-cli.test.ts drives it end-to-end for the exit-code mapping;
 *     here we pin the FINDING itself (exactly one, id/severity/dispatch_id/
 *     argv) and the probe edges. Reality note: `hasPendingMigrations` (the
 *     probe, src/core/migrate.ts) catches its own getConfig failure and
 *     returns TRUE ("can't tell → assume pending", documented fail-toward-
 *     migrate), so a rejecting engine still EMITS the critical finding —
 *     collectMigration's own `return []` catch is a second-layer guard the
 *     engine seam cannot reach today.
 *
 *   - collect-uninstalled-brain-pack.ts: the five gates (remote ctx, install
 *     ledger exact-version match, version mismatch, nag ceiling, nag reset on
 *     version bump) plus the manifest preconditions. Disk state
 *     (skillpack-state.json / skillpack-nag-state.json) lives under
 *     GBRAIN_HOME, isolated per test via withEnv + a fresh temp home; the
 *     pack fixture is a real skillpack.json on disk because the collector
 *     runs the real loadSkillpackManifest (which also stats the skill dirs).
 *
 * Non-serial: no mock.module, env only via withEnv, all paths under mkdtemp.
 */

import { describe, test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectMigration } from '../src/core/advisor/collect-migration.ts';
import { collectUninstalledBrainPack } from '../src/core/advisor/collect-uninstalled-brain-pack.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { saveState, SKILLPACK_STATE_SCHEMA_VERSION, type SkillpackStateEntry } from '../src/core/skillpack/state.ts';
import { saveNagState, SKILLPACK_NAG_SCHEMA_VERSION, DEFAULT_NAG_CEILING, type NagEntry } from '../src/core/skillpack/nag-state.ts';
import { deriveBrainId } from '../src/core/skillpack/brain-resident-locate.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

function ctx(engine: unknown, over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: engine as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '0.46.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-16T00:00:00Z'),
    remote: false,
    ...over,
  };
}

describe('collect-migration', () => {
  function versionEngine(version: string | null): BrainEngine {
    return {
      getConfig: async (key: string) => (key === 'version' ? version : null),
    } as unknown as BrainEngine;
  }

  test('pending migration → EXACTLY one critical pending_migration finding with the apply_migrations dispatch', async () => {
    const out = await collectMigration.collect(ctx(versionEngine('1')));
    expect(out).toHaveLength(1);
    const f = out[0]!;
    expect(f.id).toBe('pending_migration');
    expect(f.severity).toBe('critical');
    expect(f.collector).toBe('migration');
    expect(f.ask_user).toBe(true);
    // The --apply contract: allowlisted dispatch key + structured argv (never
    // a shell string) — advisor-cli's TTY/spawn gates key on exactly these.
    expect(f.fix.dispatch_id).toBe('apply_migrations');
    expect(f.fix.command_argv).toEqual(['gbrain', 'apply-migrations', '--yes']);
  });

  test('schema at LATEST_VERSION → []', async () => {
    const out = await collectMigration.collect(ctx(versionEngine(String(LATEST_VERSION))));
    expect(out).toEqual([]);
  });

  test('schema AHEAD of LATEST_VERSION (older CLI on a newer brain) → []', async () => {
    const out = await collectMigration.collect(ctx(versionEngine(String(LATEST_VERSION + 1))));
    expect(out).toEqual([]);
  });

  test('missing version row (null) → treated as v1 → finding emitted', async () => {
    const out = await collectMigration.collect(ctx(versionEngine(null)));
    expect(out.map((f) => f.id)).toEqual(['pending_migration']);
  });

  test('probe failure (getConfig rejects) → finding emitted, not [] — the probe fails toward "pending"', async () => {
    // hasPendingMigrations catches the engine error itself and returns true
    // (worst case is one extra schema replay, per its docstring), so the
    // collector's fail-open `return []` never fires through the engine seam.
    const engine = {
      getConfig: async () => {
        throw new Error('config table missing');
      },
    } as unknown as BrainEngine;
    const out = await collectMigration.collect(ctx(engine));
    expect(out.map((f) => f.id)).toEqual(['pending_migration']);
  });

  test('reality note: a corrupt non-numeric version string parses to NaN → reported as CURRENT ([])', async () => {
    // parseInt('garbage') is NaN and NaN < LATEST_VERSION is false — pinned
    // as current behavior (a corrupt version row silences the nudge; the
    // full initSchema path is the backstop there).
    const out = await collectMigration.collect(ctx(versionEngine('garbage')));
    expect(out).toEqual([]);
  });
});

describe('collect-uninstalled-brain-pack (five-gate matrix)', () => {
  const PACK_NAME = 'acme-pack';
  const PACK_VERSION = '1.2.0';

  /** A real on-disk brain-resident pack (loadSkillpackManifest stats skill dirs). */
  function makePackDir(over: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-brainpack-'));
    mkdirSync(join(dir, 'skills', 'acme-skill'), { recursive: true });
    writeFileSync(
      join(dir, 'skillpack.json'),
      JSON.stringify({
        api_version: 'gbrain-skillpack-v1',
        name: PACK_NAME,
        version: PACK_VERSION,
        description: 'test pack',
        author: 'alice-example',
        license: 'MIT',
        homepage: 'https://example.com/acme-pack',
        gbrain_min_version: '0.36.0',
        skills: ['skills/acme-skill'],
        brain_resident: true,
        ...over,
      }),
    );
    return dir;
  }

  function sourceRow(localPath: string | null, id = 'wiki') {
    return {
      id,
      name: id,
      local_path: localPath,
      last_commit: null,
      last_sync_at: null,
      config: {},
      created_at: new Date('2026-01-01T00:00:00Z'),
      archived: false,
    };
  }

  function sourcesEngine(rows: unknown[], counter = { calls: 0 }): { engine: BrainEngine; counter: { calls: number } } {
    const engine = {
      executeRaw: async () => {
        counter.calls++;
        return rows;
      },
    } as unknown as BrainEngine;
    return { engine, counter };
  }

  function installedEntry(version: string): SkillpackStateEntry {
    return {
      name: PACK_NAME,
      version,
      author: 'alice-example',
      source: '/tmp/somewhere',
      source_kind: 'local',
      pinned_commit: null,
      tarball_sha256: null,
      tier: 'local',
      scaffolded_at: '2026-01-01T00:00:00Z',
      workspace: '/tmp/workspace',
      skill_slugs: ['skills/acme-skill'],
    };
  }

  function nagEntry(packDir: string, over: Partial<NagEntry> = {}): NagEntry {
    return {
      // Same key derivation as the collector: no config.remote_url → path hash.
      brain_id: deriveBrainId(null, packDir),
      source_id: 'wiki',
      pack_name: PACK_NAME,
      pack_version: PACK_VERSION,
      prompted_at: '2026-01-01T00:00:00Z',
      declined_count: 0,
      suppressed: false,
      ...over,
    };
  }

  test('gate 1 — uninstalled brain-resident pack → one info finding (full shape)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      const out = await collectUninstalledBrainPack.collect(ctx(engine));
      expect(out).toHaveLength(1);
      const f = out[0]!;
      expect(f.id).toBe(`uninstalled_brain_pack:wiki:${PACK_NAME}`);
      expect(f.severity).toBe('info');
      expect(f.collector).toBe('uninstalled-brain-pack');
      expect(f.ask_user).toBe(true);
      // A1: install ledgers are workspace state — runAdvisor drops this over MCP.
      expect(f.workspace_dependent).toBe(true);
      // Singular/plural copy for a 1-skill pack.
      expect(f.title).toBe(`Brain source "wiki" ships 1 skill you haven't installed (${PACK_NAME}).`);
      expect(f.fix.command_argv).toEqual(['gbrain', 'skillpack', 'scaffold', packDir]);
      expect(f.fix.dispatch_id).toBeUndefined(); // scaffold is not --apply-dispatchable
    });
  });

  test('gate 2 — exact-version entry in the install ledger → suppressed', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [installedEntry(PACK_VERSION)] });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });

  test('gate 3 — ledger entry at a DIFFERENT version → not "installed" → emits', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveState({ schema_version: SKILLPACK_STATE_SCHEMA_VERSION, packs: [installedEntry('1.0.0')] });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      const out = await collectUninstalledBrainPack.collect(ctx(engine));
      expect(out.map((f) => f.id)).toEqual([`uninstalled_brain_pack:wiki:${PACK_NAME}`]);
    });
  });

  test('gate 4 — nag ceiling reached for THIS pack version → suppressed', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveNagState({
        schema_version: SKILLPACK_NAG_SCHEMA_VERSION,
        entries: [nagEntry(packDir, { declined_count: DEFAULT_NAG_CEILING, suppressed: true })],
      });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });

  test('gate 4b — a version bump re-surfaces PAST the ceiling (new version is new information)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const packDir = makePackDir();
      saveNagState({
        schema_version: SKILLPACK_NAG_SCHEMA_VERSION,
        entries: [nagEntry(packDir, { pack_version: '0.9.0', declined_count: 99, suppressed: true })],
      });
      const { engine } = sourcesEngine([sourceRow(packDir)]);
      const out = await collectUninstalledBrainPack.collect(ctx(engine));
      expect(out.map((f) => f.id)).toEqual([`uninstalled_brain_pack:wiki:${PACK_NAME}`]);
    });
  });

  test('gate 5 — remote ctx → [] before touching the engine (no workspace ledger over MCP)', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const { engine, counter } = sourcesEngine([sourceRow(makePackDir())]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine, { remote: true }))).toEqual([]);
      expect(counter.calls).toBe(0);
    });
  });

  test('preconditions — no local_path / no skillpack.json / non-resident pack are all skipped', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const noManifest = mkdtempSync(join(tmpdir(), 'gbrain-nomanifest-'));
      const nonResident = makePackDir({ brain_resident: false });
      const { engine } = sourcesEngine([
        sourceRow(null, 'pathless'),
        sourceRow(noManifest, 'bare'),
        sourceRow(nonResident, 'registry-style'),
      ]);
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });

  test('fail-open — loadAllSources throwing → []', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const engine = {
        executeRaw: async () => {
          throw new Error('relation "sources" does not exist');
        },
      } as unknown as BrainEngine;
      expect(await collectUninstalledBrainPack.collect(ctx(engine))).toEqual([]);
    });
  });
});
