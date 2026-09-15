/**
 * claude-cli declares prompt caching, because the CLI caches.
 *
 * The recipe used to declare `supports_prompt_cache: false` on the grounds
 * that the CLI "does not surface it via the standard cache_control control
 * plane" — true, but that is the wrong question. The contract on
 * `ProviderCapabilities.supportsPromptCaching` (src/core/ai/capabilities.ts)
 * is explicit that the field means "does it cache", by EITHER mechanism, and
 * that the `degraded:no_caching` advice "is wrong for a provider that caches
 * without being asked".
 *
 * Claude Code caches automatically, `--print` runs included — the mode this
 * provider dispatches. Those runs sit in its "main conversation" TTL bucket,
 * which is one hour on a Claude subscription:
 * https://code.claude.com/docs/en/prompt-caching
 *
 * The user-visible symptom was doctor's `subagent_capability` telling every
 * claude-cli operator their subagent loop "runs hot" and to switch to
 * `anthropic:` — advice that trades a subscription-billed path for a metered
 * one to buy caching the operator already had. Same unclearable-warning class
 * as #4575, which is pinned in test/doctor-subagent-capability.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { getProviderCapabilities, classifyCapabilities } from '../../src/core/ai/capabilities.ts';
import { checkSubagentCapability } from '../../src/commands/doctor.ts';

function fakeEngine(entries: Record<string, string>) {
  const config = new Map(Object.entries(entries));
  return {
    async getConfig(key: string): Promise<string | null> {
      return config.get(key) ?? null;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Every chat model the recipe lists — the declaration is a flat boolean, so
// none of them may classify as uncached.
const CLAUDE_CLI_MODELS = getRecipe('claude-cli')!.touchpoints.chat!.models ?? [];

describe('recipe: claude-cli prompt cache', () => {
  test('the capability layer reports caching for every listed model', () => {
    expect(CLAUDE_CLI_MODELS.length).toBeGreaterThan(0);
    for (const id of CLAUDE_CLI_MODELS) {
      expect(getProviderCapabilities(`claude-cli:${id}`).supportsPromptCaching).toBe(true);
    }
  });

  test('classifyCapabilities does not grade claude-cli as degraded:no_caching', () => {
    for (const id of CLAUDE_CLI_MODELS) {
      const verdict = classifyCapabilities(`claude-cli:${id}`);
      expect(verdict).not.toBe('degraded:no_caching');
      // The recipe declares tools + subagent loop, so the only remaining
      // verdict is a clean one. Asserting the exact value (rather than
      // "not degraded") keeps this from passing on an 'unknown' regression.
      expect(verdict).toBe('ok');
    }
  });

  test('doctor subagent_capability is OK on a claude-cli subagent tier', async () => {
    const engine = fakeEngine({
      'models.tier.subagent': 'claude-cli:claude-sonnet-5',
      // Short-circuits the unrelated non-Anthropic chat_model branch below the
      // capability gate, so this test does not read the host's real config.
      'agent.use_gateway_loop': 'true',
    });
    const check = await checkSubagentCapability(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('models.tier.subagent');
    // The retired advice must not come back.
    expect(check.message).not.toContain('prompt caching');
    expect(check.message).not.toContain('runs hot');
  });
});
