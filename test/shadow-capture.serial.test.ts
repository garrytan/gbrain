/**
 * Shadow capture end to end on a real PGLite brain under a temporary GBRAIN_HOME, through the engine factory.
 *
 * Protects: capture is off by default (the factory returns the bare engine and creates no capture directory);
 * `capture on` makes newly opened engines record real calls into the epoch's owner-only segment files; the
 * GBRAIN_SHADOW_CAPTURE=off kill switch makes the factory return the bare engine; a purge from a process with capture
 * off and the kill switch set still deletes the recording at once; capture delete removes recordings and says so.
 * Serial because it sets GBRAIN_HOME.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { appendPurgeIntent } from '../src/core/belief/purge-mirror.ts';
import { viewedEngine } from '../src/core/persistence/switches.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { captureDir } from '../src/shadow/capture-state.ts';
import { epochDir, readEpoch, readSegment } from '../src/shadow/capture.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';

describe('shadow capture end to end (real PGLite)', () => {
  test('off by default; on records real calls; the kill switch and a purge with capture off both hold', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-capture-e2e-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_SHADOW_CAPTURE: undefined }, async () => {
        const config = { engine: 'pglite', database_path: join(home, 'brain.pglite') } as EngineConfig;
        const { saveConfig } = await import('../src/core/config.ts');
        saveConfig(config as never);
        const bare = await createEngine(config);
        await bare.connect(config);
        await bare.initSchema();
        expect(viewedEngine(bare)).toBe(bare);
        await bare.disconnect();
        const cap = captureDir(shadowDirFor(shadowBrainKey(config)!));
        expect(existsSync(cap)).toBe(false);

        const lines: string[] = [];
        const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), config: () => config };
        expect(await runEngineShadow(['capture', 'on', '--yes'], io)).toBe(0);
        const recording = await createEngine(config);
        await recording.connect(config);
        expect(viewedEngine(recording)).not.toBe(recording);
        await recording.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'An invented note.', timeline: '' });
        await recording.getPage('notes/example');
        await recording.disconnect();
        const dir = epochDir(cap, readEpoch(cap)!.id);
        const segs = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        const members = segs.flatMap(f => readSegment(join(dir, f)).records).map(r => r.member);
        expect(members).toContain('putPage');
        expect(members).toContain('getPage');
        for (const f of segs) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);

        await withEnv({ GBRAIN_SHADOW_CAPTURE: 'off' }, async () => {
          const killed = await createEngine(config);
          await killed.connect(config);
          expect(viewedEngine(killed)).toBe(killed);
          // A purge here, with the kill switch set, still deletes the recording at once.
          appendPurgeIntent({ request: 'r1', request_id: 'q1', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] });
          await killed.disconnect();
        });
        expect(existsSync(dir)).toBe(false);
        expect(readEpoch(cap)!.state).toBe('invalidated');

        expect(await runEngineShadow(['capture', 'delete', '--yes'], io)).toBe(0);
        expect(lines.join('\n')).toMatch(/Deleted:|Nothing to delete/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
