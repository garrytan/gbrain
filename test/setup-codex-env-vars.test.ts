/**
 * `gbrain setup codex` forwards provider key names to serve (GST-2732).
 * Codex starts stdio MCP servers with a scrubbed environment, so a key the
 * user exported reached the CLI but never the MCP child, and Codex sessions
 * stayed keyword-only. The entry lists names only (env_vars), never values.
 */
import { withEnv } from './helpers/with-env.ts';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CODEX_FORWARDED_PROVIDER_ENV, desiredCodexMcpEntry } from '../src/core/setup/codex.ts';

const ROOT = join(import.meta.dir, '..');
const plan = { launcher: '/usr/local/bin/gbrain', brainHome: '/tmp/gbrain-home-example', surface: 'starter', advertise: 'verbs', gbrainHomeEnv: '/tmp/gbrain-home-example', sourceId: null, stdioMember: null } as const;

describe('setup codex env_vars', () => {
  test('the MCP entry forwards every provider key and endpoint name, sorted', () => {
    const entry = desiredCodexMcpEntry(plan as never) as { env_vars?: string[] };
    expect(entry.env_vars).toEqual([...CODEX_FORWARDED_PROVIDER_ENV]);
    expect(entry.env_vars).toContain('OPENAI_API_KEY');
    expect(entry.env_vars).toContain('VOYAGE_API_KEY');
    expect([...CODEX_FORWARDED_PROVIDER_ENV]).toEqual([...CODEX_FORWARDED_PROVIDER_ENV].sort());
  });

  test('the entry never carries a key value, even when the key is set in setup\'s environment', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-test-value-never-written' }, () => {
      const rendered = JSON.stringify(desiredCodexMcpEntry(plan as never));
      expect(rendered).not.toContain('sk-test-value-never-written');
    });
  });

  test('the list equals the provider subset of the Codex plugin lane\'s env_vars', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, '.codex-plugin/mcp.json'), 'utf8'));
    const pluginProviders = (plugin.mcpServers.gbrain.env_vars as string[]).filter(n => /_(API_KEY|BASE_URL)$/.test(n));
    expect([...CODEX_FORWARDED_PROVIDER_ENV]).toEqual(pluginProviders);
  });
});
