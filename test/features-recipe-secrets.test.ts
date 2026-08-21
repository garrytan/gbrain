/**
 * Drift guard for `RECIPE_META` in src/commands/features.ts, plus a behavioral
 * pin on the ANY-of configured-detection predicate.
 *
 * `runFeatures` recommends "Set Up Integrations" for any recipe whose declared
 * secrets are absent from the environment. If a secret NAME in RECIPE_META does
 * not match what the recipe's own frontmatter tells the user to set, that recipe
 * is reported as unconfigured forever, no matter how the user actually sets it up.
 *
 * That had drifted on 4 of 7 entries (GOOGLE_CALENDAR_API_KEY, GMAIL_APP_PASSWORD,
 * CIRCLEBACK_API_KEY, OAUTH_CLIENT_SECRET were all names that appear nowhere in
 * the repo). Nothing caught it because the only prior test asserted that
 * `runFeatures` is defined.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { RECIPE_META, scanFeatures } from '../src/commands/features.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const recipePath = (id: string) => join(REPO_ROOT, 'recipes', `${id}.md`);

/**
 * Env var names declared under the recipe's frontmatter `secrets:` block.
 * Scoped to that block so it never picks up `name:` fields from health_checks
 * (env_exists / http). This is what the drift guard must check membership
 * against — a secret mentioned only in prose is NOT a declared secret.
 */
function frontmatterSecretNames(id: string): string[] {
  const body = readFileSync(recipePath(id), 'utf-8');
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split('\n');
  const start = lines.findIndex((l) => /^secrets:\s*$/.test(l));
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // A new top-level key (no leading whitespace) ends the secrets block.
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(/^\s*-\s*name:\s*([A-Z_][A-Z0-9_]*)\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

describe('RECIPE_META integrity', () => {
  test('every entry points at a recipe file that exists', () => {
    for (const entry of RECIPE_META) {
      expect(existsSync(recipePath(entry.id))).toBe(true);
    }
  });

  test('every declared secret name appears in its recipe frontmatter secrets block', () => {
    const drift: string[] = [];
    for (const entry of RECIPE_META) {
      const declared = new Set(frontmatterSecretNames(entry.id));
      for (const secret of entry.secrets) {
        if (!declared.has(secret)) drift.push(`${entry.id} -> ${secret}`);
      }
    }
    // A drifted name makes `gbrain features` nag about a configured recipe forever.
    // Membership is against the frontmatter `secrets:` list, NOT a substring match
    // over the whole file — a name mentioned only in prose must not pass.
    expect(drift).toEqual([]);
  });

  test('every entry declares at least one secret', () => {
    for (const entry of RECIPE_META) {
      expect(entry.secrets.length).toBeGreaterThan(0);
    }
  });

  test('secret names look like env vars (SCREAMING_SNAKE_CASE)', () => {
    for (const entry of RECIPE_META) {
      for (const secret of entry.secrets) {
        expect(secret).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe('configured-detection semantics (drives real scanFeatures)', () => {
  // A stub engine that reports a healthy, populated brain so the ONLY recommendation
  // scanFeatures can produce is 'no-integrations'. That isolates the ANY-of predicate
  // in src/commands/features.ts from every other recommendation branch.
  const stubEngine = {
    getStats: async () => ({
      page_count: 100,
      link_count: 50,
      timeline_entry_count: 20,
    }),
    getHealth: async () => ({
      missing_embeddings: 0,
      dead_links: 0,
      embed_coverage: 1,
      brain_score: 80,
    }),
    getConfig: async (key: string) => (key === 'sync.repo_path' ? '/some/repo' : null),
  } as unknown as BrainEngine;

  // Every env var RECIPE_META reads. Each test controls the whole surface through
  // withEnv (rule R1: no direct process.env mutation), so leftover env can't leak in.
  const CLEARED: Record<string, undefined> = {
    CLAWVISOR_AGENT_TOKEN: undefined, GOOGLE_CLIENT_ID: undefined, X_API_BEARER_TOKEN: undefined,
    TWILIO_AUTH_TOKEN: undefined, CIRCLEBACK_TOKEN: undefined, NGROK_AUTHTOKEN: undefined,
  };

  const noIntegrations = async () =>
    (await scanFeatures(stubEngine)).recommendations.find((r) => r.id === 'no-integrations');

  test('no relevant secret set → recommends Set Up Integrations for all recipes', async () => {
    await withEnv(CLEARED, async () => {
      const rec = await noIntegrations();
      expect(rec).toBeDefined();
      expect(rec!.pitch).toContain('7 integration recipes');
    });
  });

  test('one secret per recipe (ANY-of) clears the recommendation', async () => {
    // CLAWVISOR_AGENT_TOKEN alone satisfies email/calendar/credential-gateway
    // (their alternative Google path stays unset); the four single-path recipes get
    // their one secret. Under the correct `some` predicate, nothing is unconfigured.
    // Under the buggy `every` predicate, the three multi-path recipes would still
    // demand GOOGLE_CLIENT_ID and this recommendation would reappear — that is the
    // regression this test pins, and it exercises features.ts directly (not a copy).
    await withEnv({
      ...CLEARED,
      CLAWVISOR_AGENT_TOKEN: 'x', X_API_BEARER_TOKEN: 'x',
      TWILIO_AUTH_TOKEN: 'x', CIRCLEBACK_TOKEN: 'x', NGROK_AUTHTOKEN: 'x',
    }, async () => {
      expect(await noIntegrations()).toBeUndefined();
    });
  });

  test('a single ClawVisor token configures every alternative-auth recipe', async () => {
    // The recommended Option-A path: one ClawVisor token, no Google OAuth. All three
    // any_of recipes must count as configured, so only the four single-path recipes
    // remain unconfigured.
    await withEnv({ ...CLEARED, CLAWVISOR_AGENT_TOKEN: 'x' }, async () => {
      const rec = await noIntegrations();
      expect(rec).toBeDefined();
      expect(rec!.pitch).not.toContain('Email to Brain');
      expect(rec!.pitch).not.toContain('Calendar Sync');
      expect(rec!.pitch).not.toContain('Credential Gateway');
      expect(rec!.pitch).toContain('X/Twitter to Brain');
    });
  });
});
