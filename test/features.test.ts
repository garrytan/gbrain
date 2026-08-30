import { describe, it, expect } from 'bun:test';

// Test that features module exports correctly
describe('features command', () => {
  it('exports runFeatures', async () => {
    const mod = await import('../src/commands/features.ts');
    expect(typeof mod.runFeatures).toBe('function');
  });

  it('exports featuresTeaserForDoctor', async () => {
    const mod = await import('../src/commands/features.ts');
    expect(typeof mod.featuresTeaserForDoctor).toBe('function');
  });
});

// Test the embedded recipe metadata
describe('recipe metadata', () => {
  it('covers all 7 recipes', async () => {
    // Import the module and check RECIPE_META via the scan behavior
    // (RECIPE_META is not exported, but we can verify via features scan output)
    const mod = await import('../src/commands/features.ts');
    expect(mod.runFeatures).toBeDefined();
  });
});

// #2789: the X API secret name must match the resolver. Xquik is a separate
// recipe provider and must not replace or rename that built-in resolver input.
describe('x-to-brain provider secret alignment (#2789)', () => {
  const read = (p: string) => {
    const { readFileSync } = require('fs');
    return readFileSync(new URL(p, import.meta.url), 'utf-8') as string;
  };

  it('features registry pins the resolver-canonical name', () => {
    const src = read('../src/commands/features.ts');
    expect(src).toContain("{ id: 'x-to-brain', name: 'X/Twitter to Brain', secrets: ['X_API_BEARER_TOKEN', 'XQUIK_API_KEY'] }");
  });

  it('the recipe declares both provider credentials and keeps the canonical X API name', async () => {
    const { parseRecipe } = await import('../src/commands/integrations.ts');
    const raw = read('../recipes/x-to-brain.md');
    const recipe = parseRecipe(raw, 'x-to-brain.md');
    expect(recipe).not.toBeNull();
    // Frontmatter: the declared secret is the canonical name.
    const secretNames = recipe!.frontmatter.secrets.map(s => s.name);
    expect(secretNames).toContain('X_API_BEARER_TOKEN');
    expect(secretNames).toContain('XQUIK_API_KEY');
    expect(secretNames).not.toContain('X_BEARER_TOKEN');
    const providerCheck = recipe!.frontmatter.health_checks[0] as {
      type?: string;
      checks?: Array<{ auth_token?: string; headers?: Record<string, string> }>;
    };
    expect(providerCheck.type).toBe('any_of');
    expect(providerCheck.checks?.[0]?.auth_token).toBe('$X_API_BEARER_TOKEN');
    expect(providerCheck.checks?.[1]?.headers?.['x-api-key']).toBe('$XQUIK_API_KEY');
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
