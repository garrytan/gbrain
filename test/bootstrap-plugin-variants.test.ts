/** Pure detector boundary: explicit synthetic paths, no HOME or env mutation. */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudePluginProvidesName } from '../src/core/bootstrap/plugin-lanes.ts';

const dir = mkdtempSync(join(tmpdir(), 'plugin-variants-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
function settings(enabledPlugins: Record<string, unknown>): string {
  const path = join(dir, `settings-${sequence++}.json`);
  writeFileSync(path, JSON.stringify({ enabledPlugins }));
  return path;
}

for (const plugin of ['gbrain-daily@gbrain', 'gbrain-coding@gbrain']) {
  test(`bundled variant provides the shared MCP name: ${plugin}`, () => {
    expect(claudePluginProvidesName(settings({ [plugin]: true }), 'gbrain')).toBe(plugin);
  });
  test(`disabled or nonboolean variant is not enabled: ${plugin}`, () => {
    for (const value of [false, 'true', 1, null]) {
      expect(claudePluginProvidesName(settings({ [plugin]: value }), 'gbrain')).toBeNull();
    }
  });
  test(`variant does not provide unrelated MCP names: ${plugin}`, () => {
    expect(claudePluginProvidesName(settings({ [plugin]: true }), 'other')).toBeNull();
  });
}

test('foreign marketplace and similarly named plugins are not bundled aliases', () => {
  for (const plugin of ['gbrain-daily@other', 'gbrain-coding@other', 'gbrain-daily-extra@gbrain', 'gbrain-other@gbrain']) {
    expect(claudePluginProvidesName(settings({ [plugin]: true }), 'gbrain')).toBeNull();
  }
});

test('the existing exact-name marketplace behavior is preserved', () => {
  expect(claudePluginProvidesName(settings({ 'gbrain@gbrain': true }), 'gbrain')).toBe('gbrain@gbrain');
  expect(claudePluginProvidesName(settings({ 'gbrain@other': true }), 'gbrain')).toBe('gbrain@other');
  expect(claudePluginProvidesName(settings({ 'other@gbrain': true }), 'other')).toBe('other@gbrain');
  expect(claudePluginProvidesName(settings({ 'gbrain@gbrain': false }), 'gbrain')).toBeNull();
});

test('missing and malformed settings remain best-effort no-match', () => {
  expect(claudePluginProvidesName(join(dir, 'absent.json'), 'gbrain')).toBeNull();
  const path = join(dir, 'malformed.json');
  writeFileSync(path, '{');
  expect(claudePluginProvidesName(path, 'gbrain')).toBeNull();
});
