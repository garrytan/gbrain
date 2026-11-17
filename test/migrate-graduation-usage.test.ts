import { expect, test } from 'bun:test';
import { parseGraduationArgs } from '../src/commands/migrate-graduation.ts';
import { caught, envelopeFor, expectFunnelSuggestions } from './helpers/agent-envelope.ts';

test('every graduation usage refusal names its own next step and offers the migrate help', async () => {
  expectFunnelSuggestions('src/commands/migrate-graduation.ts', 'usage', 10);
  const both = envelopeFor(await caught(() => parseGraduationArgs(['--to', 'postgres', '--url', 'x', '--url-env', 'GBRAIN_TARGET_URL'])));
  expect(both).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'migrate', '--help'], next: 'run' } });
  expect(both.suggestion).toContain('Keep --url-env (e.g. --url-env GBRAIN_TARGET_URL) and drop --url');
  expect(envelopeFor(await caught(() => parseGraduationArgs(['--plan']))).suggestion).toContain('foresights migrate --to postgres --url-env GBRAIN_TARGET_URL --plan');
});
