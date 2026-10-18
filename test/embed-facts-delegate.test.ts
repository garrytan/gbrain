import { describe, expect, test } from 'bun:test';
import { parseFactEmbedArgs } from '../src/commands/embed-facts-delegate.ts';
import { validateEmbedFactsOptions } from '../src/core/embed-facts-options.ts';
import { parsePersistenceSyncArgs } from '../src/commands/sync-persistence-delegate.ts';
import { caught, envelopeFor, expectFunnelSuggestions } from './helpers/agent-envelope.ts';

describe('owner-delegated CLI refusals name their own next step', () => {
  test('every funnel call site carries a site-specific suggestion', () => {
    expectFunnelSuggestions('src/commands/embed-facts-delegate.ts', 'invalid', 4);
    expectFunnelSuggestions('src/core/embed-facts-options.ts', 'invalid', 6);
    // #6803 (D2): the --source refusal moved from the owner delegate to the validator both dispatch paths share.
    expectFunnelSuggestions('src/commands/extract-stale-delegate.ts', 'invalid', 2);
    expectFunnelSuggestions('src/commands/extract-stale-options.ts', 'invalid', 4);
    expectFunnelSuggestions('src/commands/sync-persistence-delegate.ts', 'invalid', 3);
  });

  test('fact repair usage refusals offer the embed help and never echo a flag value', async () => {
    const unknown = envelopeFor(await caught(() => parseFactEmbedArgs(['--stale', '--facts', '--token=synthetic-credential-value'])));
    expect(unknown).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'embed', '--help'], next: 'run' } });
    expect(unknown.suggestion).toContain('Remove --token;');
    expect(JSON.stringify(unknown)).not.toContain('synthetic-credential-value');
    const missing = envelopeFor(await caught(() => parseFactEmbedArgs(['--stale', '--facts', '--max-facts'])));
    expect(missing.suggestion).toContain('--max-facts 500');
  });

  test('applying fact repair without a cap names the preview and the approved cap', async () => {
    const env = envelopeFor(await caught(() => validateEmbedFactsOptions({ sourceId: 'notes', yes: true })));
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('gbrain embed --stale --facts --source notes --dry-run');
  });

  test('an unsupported delegated sync flag lists the flags the owner accepts', async () => {
    const env = envelopeFor(await caught(() => parsePersistenceSyncArgs(['--bogus=synthetic-credential-value'])));
    expect(env).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'sync', '--help'], next: 'run' } });
    expect(env.suggestion).toContain('--no-pull');
    expect(JSON.stringify(env)).not.toContain('synthetic-credential-value');
  });
});
