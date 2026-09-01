/**
 * #4575 — doctor's `subagent_capability` check must resolve the effective
 * subagent model in the SAME precedence as the runtime
 * (`resolveModelDetailed`: configKey `models.subagent` → tier override
 * `models.tier.subagent` → `models.default`, per the #3873 hoist).
 *
 * Pre-fix the check evaluated models.default BEFORE models.tier.subagent
 * (the pre-#3873 ordering), so on any brain setting both keys it reported a
 * degraded:no_caching warning naming the wrong model — and its own suggested
 * fix (`gbrain config set models.tier.subagent anthropic:...`) was the key
 * the check read last, so following doctor's advice could never clear
 * doctor's finding.
 *
 * The second block is the source-order pin: for every prefix of the shared
 * precedence list, the key the CHECK reports must be the key the RUNTIME
 * picks, driven through resolveModelDetailed itself.
 */

import { describe, test, expect } from 'bun:test';
import { checkSubagentCapability } from '../src/commands/doctor.ts';
import {
  resolveModelDetailed,
  SUBAGENT_CONFIG_KEY_PRECEDENCE,
  type ResolveSource,
} from '../src/core/model-config.ts';

function fakeEngine(entries: Record<string, string>) {
  const config = new Map(Object.entries(entries));
  return {
    async getConfig(key: string): Promise<string | null> {
      return config.get(key) ?? null;
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('subagent_capability precedence (#4575)', () => {
  test('the exact issue repro: non-Anthropic models.default + Anthropic tier override → no warning', async () => {
    const engine = fakeEngine({
      // A model whose provider lacks prompt caching — pre-fix this is what
      // the check (wrongly) graded and warned about, unclearably.
      'models.default': 'google:gemini-1.5-pro',
      // The tier override the warning itself tells the operator to set.
      'models.tier.subagent': 'anthropic:claude-sonnet-4-6',
    });
    const check = await checkSubagentCapability(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('models.tier.subagent');
    expect(check.message).not.toContain('models.default');
  });

  test('source-order pin: the check reports exactly the key the runtime resolves', async () => {
    // Map runtime ResolveSource steps to the config keys the check names.
    const sourceToKey: Partial<Record<ResolveSource, string>> = {
      config_key: 'models.subagent',
      tier_config: 'models.tier.subagent',
      models_default: 'models.default',
    };

    // Distinct capable (Anthropic) models per key so the winner is visible.
    const modelForKey: Record<string, string> = {
      'models.subagent': 'anthropic:claude-opus-4-7',
      'models.tier.subagent': 'anthropic:claude-sonnet-4-6',
      'models.default': 'anthropic:claude-haiku-4-5',
    };

    // Every non-empty suffix of the precedence list: [all three], [tier,
    // default], [default]. In each, the FIRST key present must win for both
    // the runtime and the check.
    for (let start = 0; start < SUBAGENT_CONFIG_KEY_PRECEDENCE.length; start++) {
      const present = SUBAGENT_CONFIG_KEY_PRECEDENCE.slice(start);
      const entries = Object.fromEntries(present.map((k) => [k, modelForKey[k]!]));
      const engine = fakeEngine(entries);

      const runtime = await resolveModelDetailed(engine, {
        configKey: 'models.subagent',
        tier: 'subagent',
        fallback: 'anthropic:claude-sonnet-4-6',
      });
      const runtimeKey = sourceToKey[runtime.source];
      expect(runtimeKey).toBe(present[0]!);
      expect(runtime.model).toBe(modelForKey[present[0]!]!);

      const check = await checkSubagentCapability(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain(`Subagent model resolves via ${runtimeKey} to "${runtime.model}"`);
    }
  });

  test('precedence list itself pins the #3873 order (tier above default)', () => {
    expect([...SUBAGENT_CONFIG_KEY_PRECEDENCE]).toEqual([
      'models.subagent',
      'models.tier.subagent',
      'models.default',
    ]);
  });
});
