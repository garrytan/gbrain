/**
 * A late usage flush never brings deleted shadow evidence back (docs/guides/engine-swap.md, shadow `stop --delete`).
 *
 * Authoring gate (docs/TESTING.md): (1) protects `gbrain engine shadow stop --delete`: a resident process (serve, a
 * worker) keeps counts on its usage meter and flushes them on a timer or at disconnect, after the user deleted the
 * shadow directory. (2) Fails when `appendUsage` recreates the deleted directory. (3) The ledger writers already guard
 * this; usage did not. (4) No seam: the real writer on a real temporary directory.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendUsage, readEpochUsage } from '../src/shadow/usage.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test('a usage flush after the shadow directory was deleted writes nothing and recreates nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-usage-'));
  roots.push(root);
  const dir = join(root, 'shadow', 'pglite-abc');
  const line = { ts: '2026-11-23T00:00:00.000Z', epoch_id: 'e1', ops: { getPage: { offered: 1 } as never } };
  rmSync(dir, { recursive: true, force: true });
  appendUsage(dir, line);
  expect(existsSync(dir)).toBe(false);
});

test('a usage flush into a live shadow directory still records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-usage-'));
  roots.push(dir);
  appendUsage(dir, { ts: '2026-11-23T00:00:00.000Z', epoch_id: 'e1', ops: { getPage: { offered: 1 } as never } });
  expect(readEpochUsage(dir, 'e1')?.length).toBe(1);
});
