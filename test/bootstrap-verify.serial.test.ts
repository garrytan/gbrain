/**
 * bootstrap verify — the D8 check union against a hermetic in-memory PGLite
 * brain (the resolve-ipc-v2 pattern): keyless roundtrip [G1/CX-P0.5],
 * graph floor [CX2-5], magic moment via the ## Facts fence, probe cleanup
 * [G13], failure-shape checks (token sweep / byte floors / secret scan), and
 * snapshot retention [B2].
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { readManifest, writeManifest } from '../src/core/bootstrap/format.ts';
import { initState, setAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';
import { loadQuestionBank } from '../src/core/bootstrap/assets.ts';
import { byteFloors } from '../src/core/bootstrap/render.ts';
import {
  verifyWorkspace,
  resolveVerifySourceId,
  VERIFY_PROBE_SLUG,
  VERIFY_PROBE_ENTITY_SLUG,
  VERIFY_MAGIC_TOKEN,
  VERIFY_SNAPSHOTS_KEPT,
  FIRST_RUN_TOUR,
} from '../src/core/bootstrap/verify.ts';
import { listVerifyRuns } from '../src/core/bootstrap/status.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { loadCorpusPages, loadCorpusQueries } from './helpers/bootstrap-corpus.ts';

const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

let engine: PGLiteEngine;
let tmpParent: string;
let home: string;
let ws: string;
let prevHome: string | undefined;

function pad(text: string, bytes: number): string {
  let out = text;
  while (Buffer.byteLength(out, 'utf8') < bytes) {
    out += '\nSubstantive identity prose rendered from real interview answers, not filler headers.';
  }
  return out;
}

beforeAll(async () => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-verify-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-verify-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;

  // Workspace shape: initialized manifest + interview answers (6 required,
  // confirmed) + identity files above the 6-answer byte floors + brain/.
  writeManifest(ws, {
    format_version: 1,
    initialized: true,
    agent_name: 'Verify Test Agent',
    created_by: 'test',
    created_at: new Date().toISOString(),
    source_id: 'workspace',
  });
  const bank = loadQuestionBank();
  const required = bank.interviewKeys.filter((k) => bank.questions[k]?.required === true);
  expect(initState(ws).ok).toBe(true);
  const answers: Record<string, string> = {
    AGENT_NAME: 'Testa',
    PRINCIPAL_NAME: 'Pat Example',
    AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
    AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
    PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; cares about signal over noise.',
    VOICE_REGISTER: 'Direct: three options, the second one wins.',
  };
  for (const key of required) {
    const r = setAnswer(ws, key, answers[key] ?? `a real answer for ${key}`);
    if (!r.ok) throw new Error(`setAnswer(${key}) failed: ${r.message}`);
  }
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);

  const floors = byteFloors(required.length);
  writeFileSync(
    join(ws, 'AGENTS.md'),
    '⛔ **WRITE IT DOWN — SAME TURN, THROUGH THE BRAIN.**\n\n' +
      '**Gate 7 — Write-back.** Before ending the turn, persist durable learning.\n',
  );
  writeFileSync(join(ws, 'SOUL.md'), pad('# Soul\n\nIdentity rendered from answers.\n', floors['SOUL.md'] + 200));
  writeFileSync(join(ws, 'USER.md'), pad('# User\n\nTheir literal words are ground truth.\n', floors['USER.md'] + 100));
  mkdirSync(join(ws, 'brain'), { recursive: true });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // The workspace source: brain/ registered with its own local_path so the
  // put_page write-through materializes committed files under brain/ [G1].
  await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
}, 240_000);

afterAll(async () => {
  try {
    await engine.disconnect();
  } catch {
    /* noop */
  }
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

function check(checks: Array<{ id: string; ok: boolean; warn?: boolean; detail: string }>, id: string) {
  const found = checks.filter((c) => c.id === id);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

describe('verifyWorkspace — keyless pass', () => {
  test('roundtrip + graph floor + magic moment pass with ZERO api keys; probes cleaned up', async () => {
    // Snapshot-retention setup [B2]: pre-seed old snapshots so the prune path runs.
    for (let i = 0; i < VERIFY_SNAPSHOTS_KEPT; i++) {
      writeFileSync(
        join(home, 'bootstrap', `verify-2020-01-0${i + 1}T00-00-00-000Z.json`),
        JSON.stringify({ ts: `2020-01-0${i + 1}T00:00:00.000Z`, ok: true, checks: [] }),
      );
    }

    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
    });

    // Individual checks.
    expect(check(res.checks, 'doctor_green')[0].ok).toBe(true);
    expect(check(res.checks, 'token_sweep')[0].ok).toBe(true);
    expect(check(res.checks, 'byte_floors')[0].ok).toBe(true);
    expect(check(res.checks, 'writeback_contract')[0].ok).toBe(true);
    expect(check(res.checks, 'secret_scan')[0].ok).toBe(true);
    expect(check(res.checks, 'deny_globs')[0].ok).toBe(true);
    expect(check(res.checks, 'repo_privacy')[0].ok).toBe(true); // local-only
    // execution_env is informational and NEVER gates [D-cloud].
    expect(check(res.checks, 'execution_env')[0].ok).toBe(true);
    for (const c of check(res.checks, 'roundtrip')) expect(c.ok).toBe(true);
    // #4287 wiring: the active-plane probe runs on every verify; keyless
    // installs pass it (no active plane exists to split).
    expect(check(res.checks, 'embedding_plane')[0].ok).toBe(true);
    expect(check(res.checks, 'embedding_plane')[0].detail).toContain('keyless');
    expect(check(res.checks, 'graph_floor')[0].ok).toBe(true);
    expect(check(res.checks, 'magic_moment')[0].ok).toBe(true);
    expect(check(res.checks, 'capability_report')[0].detail).toContain('keyless');
    expect(check(res.checks, 'hooks_smoke')[0].ok).toBe(true); // not installed → not applicable
    expect(check(res.checks, 'first_run_tour')[0].ok).toBe(true);
    expect(res.ok).toBe(true);

    // The report embeds the capability block + the three scripted prompts [D3.6/A4].
    expect(res.report).toContain('keyless mode');
    for (const prompt of FIRST_RUN_TOUR) {
      expect(res.report).toContain(prompt);
    }
    expect(res.tour).toEqual([...FIRST_RUN_TOUR]);

    // The OOBE hand-off block prints after the tour on PASS: ownership (this
    // ws has no origin remote → the local-only variant with the repo upgrade
    // path) and the ONE next action (the cold-start skill via ClawVisor).
    expect(res.report).toContain('What you own');
    expect(res.report).toContain('gbrain bootstrap repo');
    expect(res.report).toContain('cold-start');
    expect(res.report).toContain('ClawVisor');
    expect(res.handoff.length).toBeGreaterThan(0);

    // Probe cleanup [G13]: pages, files, and the reconciled fact are gone.
    expect(existsSync(join(ws, 'brain', `${VERIFY_PROBE_SLUG}.md`))).toBe(false);
    expect(existsSync(join(ws, 'brain', `${VERIFY_PROBE_ENTITY_SLUG}.md`))).toBe(false);
    // Tombstone-proof: the cleanup HARD-deletes via engine.deletePage — a
    // soft delete (deleted_at tombstone) would leave these rows countable.
    const probeRows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM pages WHERE slug = ANY($1::text[])`,
      [[VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG]],
    );
    expect(probeRows[0].n).toBe('0');
    const facts = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = $1 AND fact LIKE $2`,
      ['workspace', `%${VERIFY_MAGIC_TOKEN}%`],
    );
    expect(facts.length).toBe(0);

    // Snapshot persisted + retention holds at VERIFY_SNAPSHOTS_KEPT [B2].
    const runs = listVerifyRuns(home);
    expect(runs.length).toBeLessThanOrEqual(VERIFY_SNAPSHOTS_KEPT);
    expect(runs[0].ok).toBe(true); // newest = this run
  }, 240_000);

  test('a user fact that merely CONTAINS the magic-token substring survives verify [8b]', async () => {
    // A real user fact from a different page, plus a legacy NULL-slug fact,
    // both mentioning the token STRING. The probe cleanup must scope to the
    // probe page's source_markdown_slug, never a `fact LIKE %token%` match, so
    // neither of these is swept.
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source, source_markdown_slug, visibility)
       VALUES ($1, $2, 'user', $3, 'world')`,
      ['workspace', `a real note that mentions ${VERIFY_MAGIC_TOKEN} in passing`, 'wiki/real-user-note'],
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source, visibility)
       VALUES ($1, $2, 'user', 'world')`,
      ['workspace', `a legacy NULL-slug fact mentioning ${VERIFY_MAGIC_TOKEN}`],
    );

    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
    });
    expect(res.ok).toBe(true);

    // The probe fact (source_markdown_slug = probe slug) IS cleaned up …
    const probeFacts = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM facts WHERE source_id = $1 AND source_markdown_slug = $2`,
      ['workspace', VERIFY_PROBE_SLUG],
    );
    expect(probeFacts.length).toBe(0);

    // … but BOTH user facts that merely mention the token string survive.
    const survivors = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = $1 AND fact LIKE $2`,
      ['workspace', `%${VERIFY_MAGIC_TOKEN}%`],
    );
    expect(survivors.length).toBe(2);

    // Cleanup so later tests start from a clean facts table.
    await engine.executeRaw(`DELETE FROM facts WHERE source_id = $1 AND fact LIKE $2`, [
      'workspace', `%${VERIFY_MAGIC_TOKEN}%`,
    ]);
  }, 240_000);

  test('failure shapes: unresolved token + under-floor USER.md + planted secret all surface', async () => {
    const soulPath = join(ws, 'SOUL.md');
    const userPath = join(ws, 'USER.md');
    const githubPath = join(ws, 'GITHUB.md');
    const soulOriginal = readFileSync(soulPath, 'utf8');
    const userOriginal = readFileSync(userPath, 'utf8');
    try {
      writeFileSync(githubPath, '# GitHub\n\nRepo: {{GITHUB_REPO_URL}}\n');
      writeFileSync(userPath, '# tiny\n');
      writeFileSync(soulPath, soulOriginal + '\napi dump: sk-AAAAAAAAAAAAAAAAAAAAAAAA\n');

      const res = await verifyWorkspace(engine, ws, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
      });

      const token = check(res.checks, 'token_sweep')[0];
      expect(token.ok).toBe(false);
      expect(token.detail).toContain('GITHUB.md');
      expect(token.detail).toContain('GITHUB_REPO_URL');

      const floors = check(res.checks, 'byte_floors')[0];
      expect(floors.ok).toBe(false);
      expect(floors.detail).toContain('USER.md');

      const scan = check(res.checks, 'secret_scan')[0];
      expect(scan.ok).toBe(false);
      expect(scan.detail).toContain('openai');
      // Redaction discipline: the finding detail NEVER carries the secret value.
      expect(scan.detail).not.toContain('sk-AAAAAAAAAAAAAAAAAAAAAAAA');

      expect(res.ok).toBe(false);

      // Tour gating on FAIL: the report says fix-first and withholds the
      // celebration prompts ("broken, but go enjoy it" is a mixed signal) …
      expect(res.report).toContain('Fix the FAIL checks above');
      expect(res.report).not.toContain('Who am I to you?');
      // … the hand-off block is withheld with the tour (celebrating ownership
      // of a FAILED install is the same mixed signal) …
      expect(res.report).not.toContain('What you own');
      expect(res.report).not.toContain('cold-start');
      // … while the returned tour + handoff arrays stay unconditional so
      // machine consumers (--json) keep a stable shape, and the check names
      // the gate.
      expect(res.tour).toEqual([...FIRST_RUN_TOUR]);
      expect(res.handoff.length).toBeGreaterThan(0);
      expect(check(res.checks, 'first_run_tour')[0].detail).toContain('withheld');
    } finally {
      rmSync(githubPath, { force: true });
      writeFileSync(userPath, userOriginal);
      writeFileSync(soulPath, soulOriginal);
    }
  }, 240_000);
});

describe('verifyWorkspace — write-through disabled by config', () => {
  test('sync.write_through=false → roundtrip WARNs naming the config key; the rest of the family still runs', async () => {
    await engine.setConfig('sync.write_through', 'false');
    _resetWriteThroughCacheForTest(); // prior verify runs primed the ~30s per-engine cache
    try {
      const res = await verifyWorkspace(engine, ws, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
      });
      const wtWarn = check(res.checks, 'roundtrip').find((c) => c.detail.includes('sync.write_through'));
      expect(wtWarn).toBeDefined();
      expect(wtWarn!.ok).toBe(true);
      expect(wtWarn!.warn).toBe(true);
      // The remaining roundtrip-family checks still ran off the DB row.
      expect(check(res.checks, 'graph_floor')[0].ok).toBe(true);
      expect(check(res.checks, 'magic_moment')[0].ok).toBe(true);
      expect(res.ok).toBe(true);
      // No file materialized under brain/ (DB-only by operator choice).
      expect(existsSync(join(ws, 'brain', `${VERIFY_PROBE_SLUG}.md`))).toBe(false);
    } finally {
      await engine.unsetConfig('sync.write_through');
      _resetWriteThroughCacheForTest();
    }
  }, 240_000);
});

describe('verifyWorkspace — engine-plane side effects', () => {
  test('[CX-P1.1] facts.default_visibility: unset → set to world; explicit private → untouched', async () => {
    const e2 = new PGLiteEngine();
    await e2.connect({});
    await e2.initSchema();
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-verify-vis-'));
    try {
      mkdirSync(join(ws2, 'brain'), { recursive: true });
      expect(await e2.getConfig('facts.default_visibility')).toBeNull();

      const res = await verifyWorkspace(e2, ws2, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
        sweepBudgetMs: 5_000,
      });
      // Fresh engine: posture set to world through the engine config plane…
      expect(await e2.getConfig('facts.default_visibility')).toBe('world');
      // …and the report names the posture + where to flip it, in one line.
      const check = res.checks.find((c) => c.id === 'facts_visibility')!;
      expect(check.ok).toBe(true);
      expect(check.detail).toContain('world');
      expect(check.detail).toContain('facts.default_visibility');
      expect(check.detail).toContain('gbrain config set');

      // Pre-set explicit value survives verify (set-if-unset, never override).
      await e2.setConfig('facts.default_visibility', 'private');
      const res2 = await verifyWorkspace(e2, ws2, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
        sweepBudgetMs: 5_000,
      });
      expect(await e2.getConfig('facts.default_visibility')).toBe('private');
      const check2 = res2.checks.find((c) => c.id === 'facts_visibility')!;
      expect(check2.detail).toContain('private');
      expect(check2.detail).toContain('untouched');
    } finally {
      await e2.disconnect();
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 240_000);

  test('mcp_surface=verbs in config → loud WARN naming the --surface full fix', async () => {
    const cfgPath = join(home, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', mcp_surface: 'verbs' }), 'utf8');
    try {
      const res = await verifyWorkspace(engine, ws, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
      });
      const check = res.checks.find((c) => c.id === 'mcp_surface')!;
      expect(check.ok).toBe(true);
      expect(check.warn).toBe(true);
      expect(check.detail).toContain('verbs');
      expect(check.detail).toContain('--surface full');
    } finally {
      rmSync(cfgPath, { force: true });
    }
  }, 240_000);
});

describe('verifyWorkspace — source_id collision resolution', () => {
  test('single workspace: id registered to THIS checkout stays unchanged (no collision check emitted)', async () => {
    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
      skipHooksSmoke: true,
    });
    const m = readManifest(ws);
    expect(m.state).toBe('initialized');
    if (m.state === 'initialized') expect(m.manifest.source_id).toBe('workspace');
    expect(res.checks.find((c) => c.id === 'source_id')).toBeUndefined();
  }, 240_000);

  test("second workspace claiming a taken 'workspace' id derives workspace-<8char-hash> and persists it", async () => {
    const e2 = new PGLiteEngine();
    await e2.connect({});
    await e2.initSchema();
    const firstBrain = mkdtempSync(join(tmpdir(), 'gb-verify-first-brain-'));
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-verify-second-ws-'));
    try {
      // The brain already has 'workspace' registered to ANOTHER checkout.
      await addSource(e2, { id: 'workspace', localPath: firstBrain, force: true });
      mkdirSync(join(ws2, 'brain'), { recursive: true });
      writeManifest(ws2, {
        format_version: 1,
        initialized: true,
        agent_name: 'Second',
        created_by: 'test',
        created_at: new Date().toISOString(),
        source_id: 'workspace',
      });

      const res = await verifyWorkspace(e2, ws2, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
        sweepBudgetMs: 5_000,
      });
      const m = readManifest(ws2);
      expect(m.state).toBe('initialized');
      if (m.state !== 'initialized') throw new Error('unreachable');
      const derived = m.manifest.source_id;
      expect(derived).toMatch(/^workspace-[0-9a-f]{8}$/);
      const check = res.checks.find((c) => c.id === 'source_id')!;
      expect(check.warn).toBe(true);
      expect(check.detail).toContain(derived);
      expect(check.detail).toContain(`gbrain sources add ${derived}`);
      expect(check.detail).toContain('hooks --repair');

      // Re-run is stable: the derived id is not itself in collision.
      const res2 = await verifyWorkspace(e2, ws2, {
        sourceId: derived,
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
        sweepBudgetMs: 5_000,
      });
      const m2 = readManifest(ws2);
      if (m2.state !== 'initialized') throw new Error('unreachable');
      expect(m2.manifest.source_id).toBe(derived);
      expect(res2.checks.find((c) => c.id === 'source_id')).toBeUndefined();
    } finally {
      await e2.disconnect();
      rmSync(firstBrain, { recursive: true, force: true });
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('verifyWorkspace — workspace source registration (#4328)', () => {
  test("uninitialized workspace resolves through the source resolver to 'default' and verify passes", async () => {
    const e2 = new PGLiteEngine();
    await e2.connect({});
    await e2.initSchema();
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-verify-uninit-'));
    try {
      mkdirSync(join(ws2, 'brain'), { recursive: true });
      // Identity files above the 0-answer floors (uninit ws — no interview ran).
      const floors0 = byteFloors(0);
      writeFileSync(join(ws2, 'SOUL.md'), pad('# Soul\n\nMinimal identity.\n', floors0['SOUL.md'] + 200));
      writeFileSync(join(ws2, 'USER.md'), pad('# User\n\nMinimal user notes.\n', floors0['USER.md'] + 100));
      // The writeback_contract check requires the integrated gate; this test
      // exercises source resolution, not the contract audit.
      writeFileSync(
        join(ws2, 'AGENTS.md'),
        '⛔ **WRITE IT DOWN — SAME TURN, THROUGH THE BRAIN.**\n\n' +
          '**Gate 7 — Write-back.** Before ending the turn, persist durable learning.\n',
      );
      // No manifest at all — the pre-fix hardcoded 'workspace' fallback made
      // put_page fail its sources FK on any brain that never registered it.
      const resolved = await resolveVerifySourceId(e2, ws2);
      expect(resolved).toBe('default');
      // The shape `gbrain sources add` leaves behind: the resolved source's
      // local_path is the workspace brain/ so write-through materializes.
      // (Direct UPDATE — 'default' is seeded by migration, so add would collide.)
      await e2.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [join(ws2, 'brain')]);
      const res = await verifyWorkspace(e2, ws2, {
        sourceId: resolved,
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        skipHooksSmoke: true,
        sweepBudgetMs: 5_000,
      });
      if (!res.ok) console.error(res.report);
      expect(res.ok).toBe(true);
      for (const c of res.checks) expect(c.detail).not.toContain('foreign key');
    } finally {
      await e2.disconnect();
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 240_000);

  test('unregistered workspace source → named actionable FAIL, probe writes + hooks smoke skipped, no raw FK error', async () => {
    const e2 = new PGLiteEngine();
    await e2.connect({});
    await e2.initSchema();
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-verify-unreg-'));
    try {
      mkdirSync(join(ws2, 'brain'), { recursive: true });
      writeManifest(ws2, {
        format_version: 1,
        initialized: true,
        agent_name: 'Unregistered',
        created_by: 'test',
        created_at: new Date().toISOString(),
        source_id: 'workspace',
      });
      // Initialized manifest wins resolution — but 'workspace' was never
      // `gbrain sources add`-ed on this brain.
      expect(await resolveVerifySourceId(e2, ws2)).toBe('workspace');
      const res = await verifyWorkspace(e2, ws2, {
        sourceId: 'workspace',
        gbrainHomeDir: home,
        capabilities: KEYLESS,
        sweepBudgetMs: 5_000,
      });
      expect(res.ok).toBe(false);
      const rt = check(res.checks, 'roundtrip');
      expect(rt.length).toBe(1);
      expect(rt[0].ok).toBe(false);
      expect(rt[0].detail).toContain(`gbrain sources add workspace --path ${join(ws2, 'brain')}`);
      // The named FAIL replaces the raw FK violation the put used to surface.
      for (const c of res.checks) expect(c.detail).not.toContain('foreign key');
      // put_page was SKIPPED (not attempted-and-failed): zero probe rows.
      const rows = await e2.executeRaw<{ n: string }>(
        `SELECT count(*)::text AS n FROM pages WHERE slug = ANY($1::text[])`,
        [[VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG]],
      );
      expect(rows[0].n).toBe('0');
      // The hooks smoke binds the workspace source id — skipped with the same pointer.
      const hooks = check(res.checks, 'hooks_smoke')[0];
      expect(hooks.ok).toBe(true);
      expect(hooks.detail).toContain('not registered');
    } finally {
      await e2.disconnect();
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 240_000);
});

describe('verifyWorkspace — real corpus graph floor + qrels recall', () => {
  test('auto-link builds real multi-entity edges; verify passes on the populated brain; gold queries recall the expected pages', async () => {
    // Seed the synthetic world into the SAME workspace source verify checks,
    // through the real put_page handler so auto-link builds REAL edges — a
    // 12-page graph, not the 2-node self-planted probe pair verify writes.
    const loaded = await loadCorpusPages(engine, { sourceId: 'workspace' });
    expect(loaded).toContain('people/alice-example');
    expect(loaded).toContain('companies/ridge-platform');

    // Real edges exist from the wikilinks in the page bodies (not the probe):
    // alice-example → ridge-platform, with multiple outbound edges on a real
    // entity, and the reverse edge answers through the backlink table.
    const aliceLinks = await engine.getLinks('people/alice-example', { sourceId: 'workspace' });
    const aliceTargets = aliceLinks.map((l) => l.to_slug);
    expect(aliceTargets).toContain('companies/ridge-platform');
    expect(aliceTargets.length).toBeGreaterThanOrEqual(2);
    const ridgeBacklinks = await engine.getBacklinks('companies/ridge-platform', { sourceId: 'workspace' });
    expect(ridgeBacklinks.map((l) => l.from_slug)).toContain('people/alice-example');

    // verify still runs green end-to-end on the now-populated brain, and its
    // graph_floor / roundtrip checks pass alongside the real corpus graph.
    const res = await verifyWorkspace(engine, ws, {
      sourceId: 'workspace',
      gbrainHomeDir: home,
      capabilities: KEYLESS,
      skipHooksSmoke: true,
    });
    if (!res.ok) console.error(res.report);
    expect(res.ok).toBe(true);
    expect(check(res.checks, 'graph_floor')[0].ok).toBe(true);
    for (const c of check(res.checks, 'roundtrip')) expect(c.ok).toBe(true);

    // qrels: each gold page-recall case returns its expected slug through the
    // REAL keyword-search query op (keyless), over the multi-page corpus.
    const queryOp = operations.find((o) => o.name === 'query')!;
    const ctx: OperationContext = {
      engine,
      config: { engine: 'pglite' } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      dryRun: false,
      remote: false,
      sourceId: 'workspace',
    };
    const goldPageCases = loadCorpusQueries().filter((q) => q.kind === 'page');
    expect(goldPageCases.length).toBeGreaterThan(0);
    const misses: string[] = [];
    for (const q of goldPageCases) {
      const result = await queryOp.handler(ctx, { query: q.query, limit: 10, expand: false });
      if (!JSON.stringify(result).includes(q.expect_slug!)) {
        misses.push(`${q.id}: "${q.query}" did not recall ${q.expect_slug}`);
      }
    }
    expect(misses).toEqual([]);
  }, 240_000);
});
