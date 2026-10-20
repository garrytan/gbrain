/**
 * Temporal typed edges — the one-shot post-upgrade [AGENT] notice states the
 * contradiction-check mode the brain will actually run: apply (certified
 * model, closures written as undoable timeline lines) or propose.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { temporalEdgesUpgradeNotice, printTemporalEdgesUpgradeNotice } from '../src/core/temporal-edges-upgrade-notice.ts';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });

describe('temporal edges upgrade notice', () => {
  test('a certified model announces apply mode and how to undo; an explicit propose says so; printed once', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-placeholder' }, async () => {
      resetGateway();
      await engine.setConfig('models.dream.edge_contradictions', 'anthropic:claude-sonnet-5-5');
      const apply = (await temporalEdgesUpgradeNotice(engine))!.join('\n');
      expect(apply).toContain('certified for apply mode');
      expect(apply).toContain('gbrain edge-proposals undo');
      await engine.setConfig('dream.edge_contradictions.mode', 'propose');
      const propose = (await temporalEdgesUpgradeNotice(engine))!.join('\n');
      expect(propose).toContain('In propose mode it writes nothing to pages');
      const lines: string[] = [];
      expect(await printTemporalEdgesUpgradeNotice(engine, l => lines.push(l))).toBe(true);
      expect(await printTemporalEdgesUpgradeNotice(engine, l => lines.push(l))).toBe(false);
    });
  });
});
