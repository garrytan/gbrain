/**
 * `gbrain models route claude-cli` — the opt-in subscription routing preset.
 *
 * Protects: the preset is a dry run until `--apply`; `--apply` writes every
 * tier, the global default, the three aliases, the facts and atom extraction
 * routes and the `models.route` marker, and stores the pre-apply values under
 * `models.route.undo`; a second apply keeps that first snapshot; `--undo`
 * previews and `--undo --apply` restores the stored values (unset stays
 * unset) and clears both bookkeeping keys; `gbrain models` then attributes
 * every tier to its config key; `routeSurfaces()` reports which surfaces leave
 * the provider before and after the preset, judging a keyed provider with no
 * key present as `fails_no_key`.
 * Fails when: the `route` subcommand is not dispatched (the table prints
 * instead of a plan), a key is written on the dry run, the snapshot is
 * overwritten, undo leaves a preset key behind, or a surface's standing is
 * misjudged.
 * Existing coverage: none — the subcommand and the scan are new.
 * Seams: the same StubConfigEngine `gbrain models` is already tested with.
 *
 * Env is pinned keyless (no ANTHROPIC/OPENAI key, GBRAIN_HOME at a missing
 * dir) so the built-in defaults resolve the same way on every machine.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runModels } from '../src/commands/models.ts';
import {
  CLAUDE_CLI_ROUTE_PRESET,
  ROUTE_MARKER_KEY,
  ROUTE_UNDO_KEY,
  routeSurfaces,
  type RoutePlan,
} from '../src/commands/models-route.ts';

class StubConfigEngine {
  readonly config = new Map<string, string>();
  async getConfig(key: string): Promise<string | null> { return this.config.get(key) ?? null; }
  async setConfig(key: string, value: string): Promise<void> { this.config.set(key, value); }
  async unsetConfig(key: string): Promise<number> { return this.config.delete(key) ? 1 : 0; }
  async getPage(): Promise<{ source_id: string }> { return { source_id: 'default' }; }
}

const PINNED = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GBRAIN_HOME', 'GBRAIN_MODEL', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GBRAIN_HOME = join(tmpdir(), `gbrain-route-test-missing-${process.pid}`);
});
afterEach(() => {
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

async function run(engine: StubConfigEngine, args: string[]): Promise<{ stdout: string; json: RoutePlan | null }> {
  let stdout = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runModels(engine as never, ['route', ...args]);
  } finally {
    process.stdout.write = original;
  }
  let json: RoutePlan | null = null;
  try { json = JSON.parse(stdout) as RoutePlan; } catch { json = null; }
  return { stdout, json };
}

const PRESET_KEYS = CLAUDE_CLI_ROUTE_PRESET.keys.map(k => k.key);

describe('gbrain models route claude-cli', () => {
  test('dry run prints the plan and writes nothing', async () => {
    const engine = new StubConfigEngine();
    const { json } = await run(engine, ['claude-cli', '--json']);
    expect(json?.mode).toBe('preview');
    expect(json?.applied).toBe(false);
    expect(json?.rows.map(r => r.key)).toEqual([...PRESET_KEYS, ROUTE_MARKER_KEY]);
    for (const row of json!.rows) {
      expect(row.before).toBeNull();
      expect(row.change).toBe('set');
    }
    expect(engine.config.size).toBe(0);
  });

  test('--apply writes every key, the marker and the pre-apply snapshot', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.tier.utility', 'openai:gpt-5-mini');
    const { json } = await run(engine, ['claude-cli', '--apply', '--json']);
    expect(json?.mode).toBe('apply');
    expect(json?.applied).toBe(true);
    for (const k of CLAUDE_CLI_ROUTE_PRESET.keys) expect(engine.config.get(k.key)).toBe(k.value);
    expect(engine.config.get(ROUTE_MARKER_KEY)).toBe('claude-cli');
    const snapshot = JSON.parse(engine.config.get(ROUTE_UNDO_KEY)!) as Record<string, string | null>;
    expect(snapshot['models.tier.utility']).toBe('openai:gpt-5-mini');
    expect(snapshot['models.default']).toBeNull();
    expect(snapshot[ROUTE_MARKER_KEY]).toBeNull();
  });

  test('a second --apply keeps the first snapshot', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.default', 'anthropic:claude-sonnet-4-6');
    await run(engine, ['claude-cli', '--apply']);
    engine.config.set('models.default', 'deepseek:deepseek-v4-flash'); // hand edit after the first apply
    await run(engine, ['claude-cli', '--apply']);
    const snapshot = JSON.parse(engine.config.get(ROUTE_UNDO_KEY)!) as Record<string, string | null>;
    expect(snapshot['models.default']).toBe('anthropic:claude-sonnet-4-6');
    expect(engine.config.get('models.default')).toBe('claude-cli:claude-sonnet-5-5');
  });

  test('--undo previews, --undo --apply restores the stored values and clears the bookkeeping keys', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.tier.deep', 'anthropic:claude-opus-5-5');
    await run(engine, ['claude-cli', '--apply']);

    const preview = await run(engine, ['claude-cli', '--undo', '--json']);
    expect(preview.json?.mode).toBe('undo-preview');
    expect(preview.json?.undo_without_snapshot).toBe(false);
    expect(preview.json?.rows.find(r => r.key === 'models.tier.deep')).toMatchObject({ change: 'restore', after: 'anthropic:claude-opus-5-5' });
    expect(preview.json?.rows.find(r => r.key === 'models.default')).toMatchObject({ change: 'unset', after: null });
    expect(engine.config.get('models.default')).toBe('claude-cli:claude-sonnet-5-5'); // preview wrote nothing

    const undone = await run(engine, ['claude-cli', '--undo', '--apply', '--json']);
    expect(undone.json?.mode).toBe('undo');
    expect(engine.config.get('models.tier.deep')).toBe('anthropic:claude-opus-5-5');
    for (const k of PRESET_KEYS.filter(k => k !== 'models.tier.deep')) expect(engine.config.has(k)).toBe(false);
    expect(engine.config.has(ROUTE_MARKER_KEY)).toBe(false);
    expect(engine.config.has(ROUTE_UNDO_KEY)).toBe(false);
  });

  test('--undo without a snapshot unsets every preset key', async () => {
    const engine = new StubConfigEngine();
    for (const k of CLAUDE_CLI_ROUTE_PRESET.keys) engine.config.set(k.key, k.value); // set by hand
    engine.config.set(ROUTE_MARKER_KEY, 'claude-cli');
    const { json } = await run(engine, ['claude-cli', '--undo', '--apply', '--json']);
    expect(json?.undo_without_snapshot).toBe(true);
    expect(engine.config.size).toBe(0);
  });

  test('after --apply, gbrain models attributes every tier to its config key', async () => {
    const engine = new StubConfigEngine();
    await run(engine, ['claude-cli', '--apply']);
    let stdout = '';
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); return true; }) as typeof process.stdout.write;
    try { await runModels(engine as never, ['--json']); } finally { process.stdout.write = original; }
    const report = JSON.parse(stdout) as { tiers: Record<string, { resolved: string; source: string }>; per_task: Array<{ key: string; resolved: string; source: string }> };
    expect(report.tiers.utility).toMatchObject({ resolved: 'claude-cli:claude-haiku-5-5', source: 'config: models.tier.utility' });
    expect(report.tiers.deep).toMatchObject({ resolved: 'claude-cli:claude-opus-5-5', source: 'config: models.tier.deep' });
    expect(report.tiers.subagent).toMatchObject({ resolved: 'claude-cli:claude-sonnet-5-5', source: 'config: models.tier.subagent' });
    // extract_atoms resolves its own key before the tier, so the preset sets it.
    const atoms = report.per_task.find(r => r.key === 'models.dream.extract_atoms');
    expect(atoms).toMatchObject({ resolved: 'claude-cli:claude-haiku-5-5', source: 'config: models.dream.extract_atoms' });
    const facts = report.per_task.find(r => r.key === 'facts.extraction_model');
    expect(facts).toMatchObject({ resolved: 'claude-cli:claude-haiku-5-5', source: 'config: facts.extraction_model' });
    // Both read their own key at runtime (runPhaseEdgeContradictions, resolveBrainstormJudgeModel).
    expect(report.per_task.find(r => r.key === 'models.dream.edge_contradictions')).toMatchObject({ resolved: 'claude-cli:claude-haiku-5-5', source: 'config: models.dream.edge_contradictions' });
    expect(report.per_task.find(r => r.key === 'models.brainstorm.judge')).toMatchObject({ resolved: 'claude-cli:claude-sonnet-5-5', source: 'config: models.brainstorm.judge' });
  });

  test('--apply overwrites a pinned edge-contradictions or brainstorm-judge model', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.dream.edge_contradictions', 'openai:gpt-5-mini');
    engine.config.set('models.brainstorm.judge', 'anthropic:claude-sonnet-4-6');
    await run(engine, ['claude-cli', '--apply']);
    expect(engine.config.get('models.dream.edge_contradictions')).toBe('claude-cli:claude-haiku-5-5');
    expect(engine.config.get('models.brainstorm.judge')).toBe('claude-cli:claude-sonnet-5-5');
    const snapshot = JSON.parse(engine.config.get(ROUTE_UNDO_KEY)!) as Record<string, string | null>;
    expect(snapshot['models.brainstorm.judge']).toBe('anthropic:claude-sonnet-4-6');
  });

  test('--apply shadows a deprecated models.auto_think pin for pinned questions', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.auto_think', 'openai:gpt-5');
    await run(engine, ['claude-cli', '--apply']);
    // resolveQuestionModel reads models.standing_questions, then models.auto_think, before the deep tier.
    const { resolveQuestionModel } = await import('../src/core/questions/refresh.ts');
    expect(await resolveQuestionModel(engine as never, { model: null })).toBe('claude-cli:claude-opus-5-5');
  });
});

describe('routeSurfaces', () => {
  test('before the preset, the built-in defaults leave claude-cli and fail for lack of a key', async () => {
    const engine = new StubConfigEngine();
    const scan = await routeSurfaces(engine as never, 'claude-cli');
    const utility = scan.surfaces.find(s => s.surface === 'tier.utility');
    expect(utility).toMatchObject({ provider: 'anthropic', standing: 'fails_no_key', missing_key: 'ANTHROPIC_API_KEY' });
    expect(scan.leaving.map(s => s.surface)).toContain('tier.deep');
    expect(scan.nightly_probe).toBe('off');
    expect(scan.surfaces.some(s => s.surface.startsWith('nightly_probe.'))).toBe(false);
  });

  test('a keyed provider is reported as billing it', async () => {
    const engine = new StubConfigEngine();
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    const scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.surfaces.find(s => s.surface === 'tier.reasoning')).toMatchObject({ provider: 'anthropic', standing: 'bills_other_provider' });
  });

  test('after the preset, every chat surface stays; the fallback chain and an enabled probe panel are named when they leave', async () => {
    const engine = new StubConfigEngine();
    await run(engine, ['claude-cli', '--apply']);
    let scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.leaving).toEqual([]);
    expect(scan.surfaces.filter(s => s.standing === 'stays').length).toBeGreaterThanOrEqual(4 + 10);
    // The mode bundle's default reranker (voyage) has no key here: live search skips it, so it is off, not leaving.
    expect(scan.surfaces.find(s => s.surface === 'reranker')).toMatchObject({ provider: 'voyage', standing: 'off' });
    expect(scan.embedding.standing).toBe('unset');

    engine.config.set('chat_fallback_chain', 'anthropic:claude-sonnet-4-6');
    engine.config.set('autopilot.nightly_quality_probe.enabled', 'true');
    scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.nightly_probe).toBe('on');
    expect(scan.leaving.find(s => s.surface === 'chat_fallback_chain[0]')).toMatchObject({ model: 'anthropic:claude-sonnet-4-6', standing: 'fails_no_key' });
    expect(scan.surfaces.find(s => s.surface === 'nightly_probe.reader')).toMatchObject({ standing: 'stays' });
  });

  test('a pinned edge-contradictions or brainstorm-judge model is a surface that leaves', async () => {
    const engine = new StubConfigEngine();
    await run(engine, ['claude-cli', '--apply']);
    engine.config.set('models.dream.edge_contradictions', 'openai:gpt-5-mini');
    engine.config.set('models.brainstorm.judge', 'anthropic:claude-sonnet-4-6');
    const scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.leaving.find(s => s.surface === 'models.dream.edge_contradictions')).toMatchObject({ provider: 'openai', standing: 'fails_no_key' });
    expect(scan.leaving.find(s => s.surface === 'models.brainstorm.judge')).toMatchObject({ provider: 'anthropic', standing: 'fails_no_key' });
  });

  test('a deprecated models.auto_think pin is reported on the pinned-question route that reads it', async () => {
    const engine = new StubConfigEngine();
    engine.config.set('models.tier.deep', 'claude-cli:claude-opus-5-5');
    engine.config.set('models.auto_think', 'openai:gpt-5');
    const scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.leaving.find(s => s.surface === 'models.standing_questions')).toMatchObject({ model: 'openai:gpt-5', provider: 'openai', standing: 'fails_no_key' });
  });

  test('a TypeSafe reranker keyed through the JEV_TYPESAFE_API_KEY alias bills TypeSafe, not off', async () => {
    const engine = new StubConfigEngine();
    await run(engine, ['claude-cli', '--apply']);
    engine.config.set('search.reranker.enabled', 'true');
    engine.config.set('search.reranker.model', 'typesafe:jev-1.13.0');
    let scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.surfaces.find(s => s.surface === 'reranker')).toMatchObject({ provider: 'typesafe', standing: 'off' });
    process.env.JEV_TYPESAFE_API_KEY = 'ts-test-not-real';
    scan = await routeSurfaces(engine as never, 'claude-cli');
    expect(scan.leaving.find(s => s.surface === 'reranker')).toMatchObject({ provider: 'typesafe', standing: 'bills_other_provider' });
  });
});
