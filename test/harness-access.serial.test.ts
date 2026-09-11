import { test } from 'bun:test';
import { harnessAccessJourney } from './helpers/harness-access-journey.ts';

test('PGLite live server: private handoff, recovery, seven verbs, live grants and atomic delegation', async () => {
  await harnessAccessJourney();
});
