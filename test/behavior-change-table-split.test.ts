/**
 * BEHAVIOR_CHANGES stays in core/behavior-change-notice.ts, so a queued PR's appended row merges cleanly, while the
 * release/baseline state and the delivery code live in behavior-notice-state.ts and behavior-notice-delivery.ts. The
 * split keeps every row in the table, emits each one in table order, and leaves the `since:` rows where the restamp
 * tooling rewrites them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BEHAVIOR_CHANGES, BEHAVIOR_NOTICE_ID, BEHAVIOR_NOTICE_SINCE, behaviorChangesNotice, compareReleases, type ChainDisclosure } from '../src/core/behavior-change-notice.ts';
import { CHAT_FALLBACK_PLANE_LABEL } from '../src/core/ai/chat-fallback-planes.ts';
import { NOTICE_FILE } from '../scripts/check-behavior-since.ts';
import { BEHAVIOR_NOTICE_FILE } from '../scripts/lib/restamp.ts';

const ROOT = resolve(import.meta.dir, '..');

describe('BEHAVIOR_CHANGES table split', () => {
  test('every row in the notice source is in the table, and the restamp tooling reads that file', () => {
    const source = readFileSync(resolve(ROOT, 'src/core/behavior-change-notice.ts'), 'utf8');
    expect(source.match(/\{ since: '/g)?.length).toBe(BEHAVIOR_CHANGES.length);
    expect([NOTICE_FILE, BEHAVIOR_NOTICE_FILE]).toEqual(['src/core/behavior-change-notice.ts', 'src/core/behavior-change-notice.ts']);
    expect(BEHAVIOR_NOTICE_ID).toBe(`behavior_changes@${BEHAVIOR_NOTICE_SINCE}`);
    expect(BEHAVIOR_CHANGES.every(c => compareReleases(c.since, BEHAVIOR_NOTICE_SINCE) <= 0)).toBe(true);
  });

  // The notice groups rows by release in the order each release first appears, keeping table order within a release.
  test('a full disclosure emits every row once, numbered in table order within its release', () => {
    const chain: ChainDisclosure = { plane: Object.keys(CHAT_FALLBACK_PLANE_LABEL)[0] as ChainDisclosure['plane'], entries: ['model-a'], providers: ['provider-a'], onRefusal: false, filePath: '/tmp/chat-fallback.json' };
    const byRelease = new Map<string, string[]>();
    for (const c of BEHAVIOR_CHANGES) byRelease.set(c.since, [...(byRelease.get(c.since) ?? []), (typeof c.text === 'string' ? c.text : c.text(chain, false))!]);
    const texts = [...byRelease.values()].flat();
    expect(texts.filter(Boolean).length).toBe(BEHAVIOR_CHANGES.length);
    const why = behaviorChangesNotice(chain)!.why;
    let at = 0;
    texts.forEach((text, i) => {
      const next = why.indexOf(`(${i + 1}) ${text}`, at);
      expect({ row: i, found: next >= at }).toEqual({ row: i, found: true });
      at = next + text.length;
    });
  });

  test('the modules load in either order (the delivery module and the table import each other)', () => {
    for (const first of ['behavior-notice-delivery.ts', 'behavior-notice-state.ts', 'behavior-change-notice.ts']) {
      const proc = Bun.spawnSync(['bun', '-e', `await import('./src/core/${first}'); const m = await import('./src/core/behavior-change-notice.ts'); console.log(m.BEHAVIOR_CHANGES.length, typeof m.takeLocalBehaviorNotice)`], { cwd: ROOT });
      expect({ first, out: proc.stdout.toString().trim(), err: proc.stderr.toString() }).toEqual({ first, out: `${BEHAVIOR_CHANGES.length} function`, err: '' });
    }
  });
});
