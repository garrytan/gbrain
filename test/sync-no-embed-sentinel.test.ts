/**
 * Deferred-setup sentinel → implicit --no-embed for `gbrain sync`.
 *
 * `gbrain init --no-embedding` writes `embedding_disabled: true` to
 * config.json. init, import, and embed honor that sentinel via
 * `assertEmbeddingEnabled`, but sync's embed credential preflight
 * (v0.41.6.0 D1) only checked the `--no-embed` CLI flag — so every
 * `gbrain sync` on a keyless deferred-setup brain exited 1 with
 * "Embedding model ... requires <PROVIDER>_API_KEY", even when nothing
 * needed embedding. embed-preflight.ts's own skip protocol says the
 * sentinel is owned upstream of the credential check.
 *
 * Pure-function tests; no DB, no gateway state.
 */
import { describe, test, expect } from 'bun:test';
import { resolveNoEmbed } from '../src/commands/sync.ts';

describe('resolveNoEmbed', () => {
  test('--no-embed flag opts out regardless of config', () => {
    expect(resolveNoEmbed(['--no-embed'], null)).toBe(true);
    expect(resolveNoEmbed(['--source', 's1', '--no-embed'], { embedding_disabled: false })).toBe(true);
  });

  test('embedding_disabled: true (deferred setup) is an implicit --no-embed', () => {
    expect(resolveNoEmbed([], { embedding_disabled: true })).toBe(true);
    expect(resolveNoEmbed(['--strategy', 'code', '--source', 's1'], { embedding_disabled: true })).toBe(true);
  });

  test('embedding-enabled brains still embed by default', () => {
    expect(resolveNoEmbed([], null)).toBe(false);
    expect(resolveNoEmbed([], {})).toBe(false);
    expect(resolveNoEmbed([], { embedding_disabled: false })).toBe(false);
  });

  test('sentinel must be strictly true — junk config values do not disable embedding', () => {
    expect(resolveNoEmbed([], { embedding_disabled: 'yes' as unknown as boolean })).toBe(false);
    expect(resolveNoEmbed([], { embedding_disabled: 1 as unknown as boolean })).toBe(false);
  });
});
