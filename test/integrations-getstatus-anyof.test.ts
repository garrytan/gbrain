/**
 * Pin for `getStatus` honoring `any_of` auth alternatives (src/commands/integrations.ts).
 *
 * The flat frontmatter `secrets:` list conflates alternative auth paths: an any_of
 * recipe lists CLAWVISOR_URL, CLAWVISOR_AGENT_TOKEN, GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET, but the user only needs ONE path (Option A ClawVisor OR
 * Option B Google). The old all-secrets-required check reported a correctly
 * configured single-path user as "available", contradicting `gbrain features`,
 * which already treats these as any-of. getStatus now honors the recipe's own
 * any_of health check.
 *
 * Recipes WITHOUT an any_of group must keep the original all-secrets-required rule.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getStatus, parseRecipe } from '../src/commands/integrations.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const recipe = (id: string) => {
  const content = readFileSync(join(REPO_ROOT, 'recipes', `${id}.md`), 'utf-8');
  const parsed = parseRecipe(content, `${id}.md`);
  if (!parsed) throw new Error(`failed to parse ${id}`);
  return parsed;
};

// Every env var these recipes read. Each test controls the whole surface through
// withEnv (rule R1: no direct process.env mutation) so leftover env can't leak in.
const CLEARED: Record<string, undefined> = {
  CLAWVISOR_URL: undefined, CLAWVISOR_AGENT_TOKEN: undefined, GOOGLE_CLIENT_ID: undefined,
  GOOGLE_CLIENT_SECRET: undefined, X_HANDLE: undefined, X_API_BEARER_TOKEN: undefined,
};

describe('getStatus honors any_of auth alternatives', () => {
  test('calendar-to-brain: no secrets → available', async () => {
    await withEnv(CLEARED, () => {
      expect(getStatus(recipe('calendar-to-brain'))).toBe('available');
    });
  });

  test('calendar-to-brain: ClawVisor path (Option A) alone → configured', async () => {
    // The recommended path: URL + agent token, no Google OAuth. The old all-of
    // rule returned "available" here because GOOGLE_CLIENT_ID/SECRET were unset.
    await withEnv({
      ...CLEARED, CLAWVISOR_URL: 'https://clawvisor.example', CLAWVISOR_AGENT_TOKEN: 'tok',
    }, () => {
      expect(getStatus(recipe('calendar-to-brain'))).toBe('configured');
    });
  });

  test('calendar-to-brain: Google path (Option B) alone → configured', async () => {
    await withEnv({ ...CLEARED, GOOGLE_CLIENT_ID: 'gid' }, () => {
      expect(getStatus(recipe('calendar-to-brain'))).toBe('configured');
    });
  });
});

describe('getStatus keeps all-secrets rule for non-any_of recipes', () => {
  test('x-to-brain: partial secrets → available', async () => {
    await withEnv({ ...CLEARED, X_API_BEARER_TOKEN: 'tok' }, () => {
      // X_HANDLE still missing
      expect(getStatus(recipe('x-to-brain'))).toBe('available');
    });
  });

  test('x-to-brain: all secrets → configured', async () => {
    await withEnv({ ...CLEARED, X_API_BEARER_TOKEN: 'tok', X_HANDLE: 'me' }, () => {
      expect(getStatus(recipe('x-to-brain'))).toBe('configured');
    });
  });
});
