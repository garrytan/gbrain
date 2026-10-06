/**
 * #5872 — the nightly quality probe resolves its model routes against the
 * live brain: the reader through `models.eval.longmemeval` and the reasoning
 * tier, the extractor through the utility tier, and each judge slot through
 * its optional `models.eval.cross_modal.slot_<x>` key. The daemon's resolver
 * refreshes the gateway from the brain first, the way queued jobs do.
 *
 * Hermetic: a stub config reader, no PGLite, no model call. Provider keys go
 * through withEnv / configureGateway({ env }); every test resets the gateway.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NightlyProbeModelRoutesError,
  resolveNightlyProbeModelRoutes,
} from '../../src/core/cycle/nightly-probe-routes.ts';
import { runNightlyQualityProbe } from '../../src/core/cycle/nightly-quality-probe.ts';
import { resolveNightlyProbeModelRoutesForDaemon } from '../../src/commands/autopilot-probes.ts';
import { configureGateway, getChatModel, resetGateway } from '../../src/core/ai/gateway.ts';
import { readRecentQualityProbeEvents } from '../../src/core/audit-quality-probe.ts';
import { surfaceFileSource } from '../helpers/source-surface.ts';
import { withEnv } from '../helpers/with-env.ts';

/** The reporter's DB plane: tiers on claude-cli, no per-task or default key. */
const REPORTED_TIERS: Record<string, string> = {
  'models.tier.utility': 'claude-cli:claude-sonnet-5',
  'models.tier.reasoning': 'claude-cli:claude-opus-5-5',
  'models.tier.deep': 'claude-cli:claude-opus-5-5',
};

function stubBrain(rows: Record<string, string>, opts: { throwOn?: (key: string) => boolean } = {}) {
  const reads: string[] = [];
  return {
    reads,
    async getConfig(key: string): Promise<string | null> {
      reads.push(key);
      if (opts.throwOn?.(key)) throw new Error('config table unavailable');
      return rows[key] ?? null;
    },
  };
}

/** No GBRAIN_MODEL and no provider key, so only the brain rows decide. */
const KEYLESS = { GBRAIN_MODEL: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined };

afterEach(() => {
  resetGateway();
});

describe('resolveNightlyProbeModelRoutes', () => {
  test('reported tier rows: reader follows the reasoning tier, extractor the utility tier', async () => {
    await withEnv({ ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant-fake' }, async () => {
      const routes = await resolveNightlyProbeModelRoutes(stubBrain(REPORTED_TIERS));
      expect(routes.reader).toEqual({ model: 'claude-cli:claude-opus-5-5', source: 'tier_config' });
      expect(routes.extractor).toEqual({ model: 'claude-cli:claude-sonnet-5', source: 'tier_config' });
      expect(routes.slots).toEqual({});
    });
  });

  test('models.eval.longmemeval beats the reasoning tier for the reader', async () => {
    await withEnv(KEYLESS, async () => {
      const routes = await resolveNightlyProbeModelRoutes(stubBrain({
        ...REPORTED_TIERS,
        'models.eval.longmemeval': 'claude-cli:claude-fable-5',
      }));
      expect(routes.reader).toEqual({ model: 'claude-cli:claude-fable-5', source: 'config_key' });
      expect(routes.extractor.model).toBe('claude-cli:claude-sonnet-5');
    });
  });

  test('slot keys: set and alias-expanded is present, blank and unset are absent', async () => {
    await withEnv(KEYLESS, async () => {
      const routes = await resolveNightlyProbeModelRoutes(stubBrain({
        ...REPORTED_TIERS,
        'models.eval.cross_modal.slot_a': ' judge-alias ',
        'models.aliases.judge-alias': 'claude-cli:claude-fable-5',
        'models.eval.cross_modal.slot_b': '   ',
      }));
      expect(routes.slots).toEqual({ A: 'claude-cli:claude-fable-5' });
    });
  });

  test('a built-in alias in a slot key expands like other models.* keys', async () => {
    await withEnv(KEYLESS, async () => {
      const routes = await resolveNightlyProbeModelRoutes(stubBrain({ 'models.eval.cross_modal.slot_c': 'sonnet' }));
      expect(routes.slots).toEqual({ C: 'anthropic:claude-sonnet-4-6' });
    });
  });

  test('empty brain on an Anthropic-keyed install: the key-aware defaults, today\'s models', async () => {
    await withEnv({ ...KEYLESS, ANTHROPIC_API_KEY: 'sk-ant-fake' }, async () => {
      const routes = await resolveNightlyProbeModelRoutes(stubBrain({}));
      expect(routes.reader).toEqual({ model: 'anthropic:claude-sonnet-4-6', source: 'tier_default' });
      expect(routes.extractor).toEqual({ model: 'anthropic:claude-haiku-4-5-20251001', source: 'tier_default' });
      expect(routes.slots).toEqual({});
    });
  });

  test('a throwing getConfig rejects with an error naming the routes', async () => {
    await withEnv(KEYLESS, async () => {
      const brain = stubBrain(REPORTED_TIERS, { throwOn: () => true });
      const err = await resolveNightlyProbeModelRoutes(brain).catch(e => e);
      expect(err).toBeInstanceOf(NightlyProbeModelRoutesError);
      expect(err.message).toContain('model routes (reader, extractor, judge slots)');
      expect(err.message).toContain('config table unavailable');
    });
  });
});

describe('resolveNightlyProbeModelRoutesForDaemon (autopilot step dep)', () => {
  test('refreshes the gateway chat model from the brain, then reads the routes', async () => {
    await withEnv(KEYLESS, async () => {
      configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
      const brain = stubBrain(REPORTED_TIERS);
      const routes = await resolveNightlyProbeModelRoutesForDaemon(brain as never);
      expect(getChatModel()).toBe('claude-cli:claude-opus-5-5');
      expect(routes.reader.model).toBe('claude-cli:claude-opus-5-5');
      expect(routes.extractor.model).toBe('claude-cli:claude-sonnet-5');
      expect(brain.reads.indexOf('models.chat')).toBeGreaterThanOrEqual(0);
      expect(brain.reads.indexOf('models.chat')).toBeLessThan(brain.reads.indexOf('models.eval.longmemeval'));
    });
  });

  test('a gateway-refresh failure becomes an error audit row naming the routes; LongMemEval never starts', async () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'probe-routes-audit-'));
    try {
      await withEnv({ ...KEYLESS, GBRAIN_AUDIT_DIR: auditDir }, async () => {
        configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
        // models.chat is read only by the gateway refresh, never by the route read.
        const brain = stubBrain(REPORTED_TIERS, { throwOn: key => key === 'models.chat' });
        let longMemEvalCalls = 0;
        const result = await runNightlyQualityProbe({
          isEnabled: () => true,
          hasEmbeddingProvider: () => true,
          resolveMaxUsd: () => 5,
          resolveRepoRoot: () => process.cwd(),
          resolveModelRoutes: () => resolveNightlyProbeModelRoutesForDaemon(brain as never),
          runLongMemEval: async () => { longMemEvalCalls++; },
          runCrossModalBatch: async () => { throw new Error('judge must not run'); },
          now: () => new Date(),
        });
        expect(result.outcome).toBe('error');
        expect(longMemEvalCalls).toBe(0);
        expect(brain.reads).not.toContain('models.eval.longmemeval');
        const events = readRecentQualityProbeEvents(2);
        expect(events).toHaveLength(1);
        expect(events[0]!.outcome).toBe('error');
        expect(events[0]!.detail).toContain('model routes (reader, extractor, judge slots)');
        expect(events[0]!.detail).toContain('config table unavailable');
      });
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('the autopilot quality-probe step wires this resolver as its resolveModelRoutes dep', () => {
    const source = surfaceFileSource('autopilot', 'src/commands/autopilot-probes.ts');
    expect(source).toContain('resolveModelRoutes: () => resolveNightlyProbeModelRoutesForDaemon(engine),');
  });
});
