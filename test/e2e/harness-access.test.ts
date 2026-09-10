import { test } from 'bun:test';
import { harnessAccessJourney } from '../helpers/harness-access-journey.ts';
import { hasDatabase } from './helpers.ts';

(hasDatabase() ? test : test.skip)('PostgreSQL live server: private handoff, recovery, seven verbs, live grants and atomic delegation', async () => {
  await harnessAccessJourney(process.env.DATABASE_URL);
});
