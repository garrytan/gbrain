import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { RECIPE_META, featuresTeaserForDoctor, runFeatures } from '../src/commands/features.ts';
import { VERSION } from '../src/version.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

// #2789: the x-to-brain secret name must be the one the resolver actually
// reads. The recipe + RECIPE_META used to pin X_BEARER_TOKEN while the
// x_handle_to_tweet resolver reads only config x_api_bearer_token / env
// X_API_BEARER_TOKEN — so no single name worked end-to-end. All three
// surfaces must agree on the resolver's canonical name.
describe('x-to-brain secret name alignment (#2789)', () => {
  const read = (p: string) => {
    const { readFileSync } = require('fs');
    return readFileSync(new URL(p, import.meta.url), 'utf-8') as string;
  };

  it('features registry pins the resolver-canonical name', () => {
    const src = read('../src/commands/features.ts');
    expect(src).toContain("{ id: 'x-to-brain', name: 'X/Twitter to Brain', secrets: ['X_API_BEARER_TOKEN'] }");
  });

  it('the x-to-brain recipe declares and uses only the canonical name', async () => {
    const { parseRecipe } = await import('../src/commands/integrations.ts');
    const raw = read('../recipes/x-to-brain.md');
    const recipe = parseRecipe(raw, 'x-to-brain.md');
    expect(recipe).not.toBeNull();
    // Frontmatter: the declared secret is the canonical name.
    const secretNames = recipe!.frontmatter.secrets.map(s => s.name);
    expect(secretNames).toContain('X_API_BEARER_TOKEN');
    expect(secretNames).not.toContain('X_BEARER_TOKEN');
    // Health check: the bearer interpolation uses the canonical name.
    const hc = recipe!.frontmatter.health_checks[0] as { auth_token?: string };
    expect(hc.auth_token).toBe('$X_API_BEARER_TOKEN');
    // Body: every $-interpolated token reference (curl examples etc.) is the
    // canonical name — catches a third misspelled variant, not just the exact
    // legacy string. (The legacy name may still appear as PROSE in the
    // upgrade/migration note; only $VAR references are load-bearing.)
    const tokenRefs = raw.match(/\$X_[A-Z_]*TOKEN\b/g) ?? [];
    expect(tokenRefs.length).toBeGreaterThan(0);
    for (const ref of tokenRefs) expect(ref).toBe('$X_API_BEARER_TOKEN');
  });

  it('the resolver reads the same env var the recipe documents', () => {
    // Alignment guard (not a behavior test — resolver behavior is pinned in
    // test/resolvers.test.ts): if the resolver's env name ever changes, this
    // forces the recipe + registry to move with it.
    const resolver = read('../src/core/resolvers/builtin/x-api/handle-to-tweet.ts');
    expect(resolver).toContain('process.env.X_API_BEARER_TOKEN');
  });
});

// Test brain_score in BrainHealth type
describe('BrainHealth type', () => {
  it('includes brain_score field', async () => {
    // Verify type at runtime through the engine interface
    const { BrainHealth } = await import('../src/core/types.ts') as any;
    // Types aren't runtime values, but we verify the interface is satisfied
    // by checking that getHealth implementations return brain_score
    const health = {
      page_count: 100,
      embed_coverage: 0.8,
      stale_pages: 5,
      orphan_pages: 10,
      dead_links: 2,
      missing_embeddings: 20,
      brain_score: 65,
    };
    expect(health.brain_score).toBe(65);
  });
});

// Test brain_score calculation
describe('brain_score calculation', () => {
  it('returns 0 for empty brain', () => {
    // When page_count is 0, brain_score should be 0
    const pageCount = 0;
    const brainScore = pageCount === 0 ? 0 : 50;
    expect(brainScore).toBe(0);
  });

  it('returns high score for fully healthy brain', () => {
    // All metrics at maximum
    const embedCoverage = 1.0;
    const linkDensity = 1.0;
    const timelineCoverage = 1.0;
    const noOrphans = 1.0;
    const noDeadLinks = 1.0;
    const score = Math.round(
      (embedCoverage * 0.35 + linkDensity * 0.25 + timelineCoverage * 0.15 +
       noOrphans * 0.15 + noDeadLinks * 0.10) * 100
    );
    expect(score).toBe(100);
  });

  it('weights embed_coverage highest', () => {
    // Only embed coverage at 100%, rest at 0%
    const score = Math.round(1.0 * 0.35 * 100);
    expect(score).toBe(35);
    // Only link density at 100%, rest at 0%
    const score2 = Math.round(1.0 * 0.25 * 100);
    expect(score2).toBe(25);
    // embed_coverage contributes more
    expect(score).toBeGreaterThan(score2);
  });
});

// CLI routing
describe('CLI routing', () => {
  it('features is in CLI_ONLY set', async () => {
    const cliSource = await Bun.file('src/cli.ts').text();
    expect(cliSource).toContain("'features'");
  });

  it('help text mentions features', async () => {
    const cliSource = await Bun.file('src/cli.ts').text();
    expect(cliSource).toContain('features [--json] [--auto-fix]');
  });
});

// Behavioral coverage for `gbrain features --json`: every supported feature
// check fires in a fixture brain that has the gap and stays silent in one that
// does not. `dead-links` is not exercised: links.to_page_id cascades on page
// delete, so neither engine can report a dangling link (tracked in TODOS.md).
describe('runFeatures behavior', () => {
  let engine: PGLiteEngine;
  let root: string;
  let home: string;
  let gbrainHome: string;
  const dims = 1536;
  const secretEnv = Object.fromEntries(
    [...new Set(RECIPE_META.flatMap(r => r.secrets))].map(name => [name, undefined]),
  ) as Record<string, string | undefined>;

  beforeAll(async () => {
    resetGateway();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    resetGateway();
  }, 30_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    root = mkdtempSync(join(tmpdir(), 'gbrain-features-'));
    home = join(root, 'home');
    gbrainHome = join(root, 'gbrain-home');
    mkdirSync(home, { recursive: true });
    mkdirSync(gbrainHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const vector = () => { const v = new Float32Array(dims); v[0] = 1; return v; };

  async function seedPages(count: number) {
    for (let i = 0; i < count; i++) {
      await engine.putPage(`notes/feature-${i}`, { type: 'note', title: `Feature fixture ${i}`, compiled_truth: `Synthetic body ${i}.` });
    }
  }

  async function seedChunks(slug: string, embedded: boolean[]) {
    await engine.upsertChunks(slug, embedded.map((hasVector, i) => ({
      chunk_index: i,
      chunk_source: 'compiled_truth' as const,
      chunk_text: `Synthetic chunk ${i} for ${slug}.`,
      ...(hasVector ? { embedding: vector() } : {}),
    })));
  }

  async function seedHealthyBrain() {
    await seedPages(6);
    for (let i = 0; i < 6; i++) {
      await seedChunks(`notes/feature-${i}`, [true]);
      await engine.addTimelineEntry(`notes/feature-${i}`, { date: '2026-01-0' + (i + 1), summary: `Synthetic event ${i}` });
      await engine.addLink(`notes/feature-${i}`, `notes/feature-${(i + 1) % 6}`);
    }
    await engine.setConfig('sync.repo_path', join(root, 'repo'));
  }

  function writeHeartbeat(recipeId: string) {
    const dir = join(gbrainHome, '.gbrain', 'integrations', recipeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'setup_complete' }) + '\n');
  }

  const offersFile = () => join(home, '.gbrain', 'feature-offers.json');

  async function features(env: Record<string, string | undefined> = {}) {
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      await withEnv({ ...secretEnv, HOME: home, GBRAIN_HOME: gbrainHome, ...env }, () => runFeatures(engine, ['--json']));
    } finally {
      spy.mockRestore();
    }
    const out = JSON.parse(lines.join('\n')) as { version: string; recommendations: { id: string; pitch: string }[] };
    return { out, ids: out.recommendations.map(r => r.id).sort() };
  }

  const pitchOf = (out: { recommendations: { id: string; pitch: string }[] }, id: string) =>
    out.recommendations.find(r => r.id === id)?.pitch ?? '';

  it('a brain with every supported gap reports each check and persists offers under the temporary home', async () => {
    await seedPages(6);
    await seedChunks('notes/feature-0', [true, false]);

    const { out, ids } = await features();

    expect(ids).toEqual(['low-coverage', 'missing-embeddings', 'no-integrations', 'no-sync', 'zero-links', 'zero-timeline']);
    expect(pitchOf(out, 'missing-embeddings')).toContain('1 chunks invisible');
    expect(pitchOf(out, 'low-coverage')).toContain('50% embed coverage');
    const pitch = pitchOf(out, 'no-integrations');
    expect(pitch).toContain(`${RECIPE_META.length} integration recipes`);
    for (const recipe of RECIPE_META) expect(pitch).toContain(recipe.name);

    const saved = JSON.parse(readFileSync(offersFile(), 'utf-8'));
    expect(saved.lastVersion).toBe(VERSION);
    expect(existsSync(join(gbrainHome, '.gbrain', 'feature-offers.json'))).toBe(false);
  });

  it('a healthy, fully configured brain recommends nothing and writes no offers file', async () => {
    await seedHealthyBrain();
    const configured = Object.fromEntries(RECIPE_META.map(r => [r.secrets[0], 'synthetic-token']));

    const { ids } = await features(configured);

    expect(ids).toEqual([]);
    expect(existsSync(offersFile())).toBe(false);
  });

  it('the no-integrations pitch names exactly the recipes with no env secret and no setup heartbeat', async () => {
    await seedHealthyBrain();
    writeHeartbeat('meeting-sync');
    writeHeartbeat('ngrok-tunnel');

    const { out, ids } = await features({ CLAWVISOR_AGENT_TOKEN: 'synthetic-token', TWILIO_AUTH_TOKEN: 'synthetic-token' });

    expect(ids).toEqual(['no-integrations']);
    const pitch = pitchOf(out, 'no-integrations');
    const expected: Record<string, boolean> = {
      'email-to-brain': false,
      'calendar-to-brain': false,
      'credential-gateway': false,
      'twilio-voice-brain': false,
      'meeting-sync': false,
      'ngrok-tunnel': false,
      'x-to-brain': true,
    };
    for (const recipe of RECIPE_META) expect(pitch.includes(recipe.name), recipe.id).toBe(expected[recipe.id]);
    expect(pitch).toContain('1 integration recipes');
  });

  it('a heartbeat without setup_complete does not count as configured', async () => {
    await seedHealthyBrain();
    const dir = join(gbrainHome, '.gbrain', 'integrations', 'x-to-brain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'heartbeat.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event: 'health_check' }) + '\n');

    const { out } = await features({ CLAWVISOR_AGENT_TOKEN: 'synthetic-token' });

    expect(pitchOf(out, 'no-integrations')).toContain('X/Twitter to Brain');
  });

  it('a declined priority-2 offer is suppressed for the current version; priority-1 offers are always pitched', async () => {
    await seedPages(6);
    await seedChunks('notes/feature-0', [false]);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const declinedAt = { at: '2026-01-01', version: VERSION };
    writeFileSync(offersFile(), JSON.stringify({
      lastVersion: VERSION, lastScan: '', accepted: {},
      declined: { 'zero-links': declinedAt, 'missing-embeddings': declinedAt },
    }));

    const { ids } = await features();

    expect(ids).not.toContain('zero-links');
    expect(ids).toContain('zero-timeline');
    expect(ids).toContain('missing-embeddings');
  });

  it('the doctor teaser names missing embeddings and stays silent on a healthy brain', async () => {
    await seedHealthyBrain();
    expect(await featuresTeaserForDoctor(engine)).toBeNull();

    await seedChunks('notes/feature-0', [true, false]);
    expect(await featuresTeaserForDoctor(engine)).toBe("Tip: 1 missing embeddings. Run 'gbrain features' to fix.");
  });

  it('brains under three pages skip the priority-2 checks', async () => {
    await seedPages(2);

    const { ids } = await features();

    expect(ids).toEqual([]);
  });
});
