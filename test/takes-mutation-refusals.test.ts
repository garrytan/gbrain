import { describe, expect, test } from 'bun:test';
import { parseTakesMutation } from '../src/commands/takes-mutation.ts';
import { caught, envelopeFor, expectFunnelSuggestions } from './helpers/agent-envelope.ts';

describe('takes mutation refusals name their own next step', () => {
  test('every invalid() call site carries a site-specific suggestion', () => {
    expectFunnelSuggestions('src/commands/takes-mutation.ts', 'invalid', 14);
  });

  test('a missing row points at the page takes listing', async () => {
    const env = envelopeFor(await caught(() => parseTakesMutation(['update', 'people/alice-example', '--weight', '0.7'])));
    expect(env).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'takes', 'people/alice-example', '--json'], next: 'run' } });
    expect(env.suggestion).toContain('foresights takes update people/alice-example --row N');
  });

  test('a flag another mutation owns names the flags this one takes and offers the help', async () => {
    const env = envelopeFor(await caught(() => parseTakesMutation(['update', 'people/alice-example', '--row', '2', '--claim', 'x'])));
    expect(env).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'takes', '--help'], next: 'run' } });
    expect(env.suggestion).toContain('Remove --claim; takes update takes --row, --weight, --source, --since');
  });

  test('an invalid quality shows the resolve usage for this row', async () => {
    const env = envelopeFor(await caught(() => parseTakesMutation(['resolve', 'people/alice-example', '--row', '3', '--quality', 'maybe'])));
    expect(env.suggestion).toContain('foresights takes resolve people/alice-example --row 3 --quality correct');
  });
});
