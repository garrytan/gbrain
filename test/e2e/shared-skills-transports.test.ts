import { describe, test } from 'bun:test';
import { sharedSkillsTransportCases } from '../fixtures/shared-skills-transport-cases.ts';
import { sharedSkillsOAuthProcessCase } from '../fixtures/shared-skills-oauth-process.ts';

const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;

(databaseUrl ? describe : describe.skip)('isolated Postgres shared skill transports', () => {
  sharedSkillsTransportCases(databaseUrl);
  test('OAuth-issued scope ceilings and live narrowing survive real HTTP and new stdio processes', () =>
    sharedSkillsOAuthProcessCase(databaseUrl!), 180_000);
  test('OAuth namespace editor delivers durable revisions to a newly launched stdio reader', () =>
    sharedSkillsOAuthProcessCase(databaseUrl!, 'skills/'), 180_000);
});
