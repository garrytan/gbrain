import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

describe('core user journeys cover packaged Desktop openability', () => {
  test('CI launches the unpacked Windows app, not source electron.exe', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/core-user-journeys.yml'), 'utf8');
    expect(workflow).toContain('core_journeys.py --packaged');
    expect(workflow).toContain('timeout-minutes: 40');
  });

  test('the journey waits for import completion instead of a stale progress prefix', () => {
    const script = readFileSync(join(ROOT, 'test/user-journeys/core_journeys.py'), 'utf8');
    expect(script).toContain('--packaged');
    expect(script).toContain('win-unpacked');
    expect(script).toContain(".materials-drawer .product-task-progress");
    expect(script).toContain('已完成');
    expect(script).toContain('materials-progress');
    expect(script).toContain('len(outcomes) != 2');
    expect(script).toContain('desktop-runtime.log');
    expect(script).toContain('build:sidecar');
    expect(script).toContain('build:dir');
    expect(script).not.toContain('importButton?.disabled');
  });

  test('the embedding switch journey clears old vectors immediately after the first confirm', () => {
    const script = readFileSync(join(ROOT, 'test/user-journeys/core_journeys.py'), 'utf8');
    const start = script.indexOf('def embedding_switch_journey');
    const next = script.indexOf('\ndef ', start + 1);
    const journey = script.slice(start, next === -1 ? undefined : next);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(journey).toContain('page.once("dialog", lambda dialog: dialog.accept())');
    expect(journey).toContain('page.locator("#save-setup").click()');
    expect(journey).toContain('page.locator("#setup-wait").wait_for(state="hidden"');
    expect(journey).toContain('run.get("kind") == "embed_stale"');
    expect(journey).toContain(".get('catchUp')");
    expect(journey).not.toContain('#setup-wait-actions');
    expect(journey).not.toContain('#setup-wait-continue');
    expect(journey).not.toContain('#setup-wait-defer');
    expect(script).not.toContain('page.locator("#setup-wait-actions").wait_for');
    expect(script).not.toContain('page.locator("#setup-wait-continue").click()');
  });
});
