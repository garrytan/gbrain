import { expect, test } from 'bun:test';
import { managedBrain } from './helpers/managed-brain.ts';
import { readMarkers, upsertMarker } from '../src/core/notifier/store.ts';
import { settleRunMarkers } from '../src/core/notifier/handoff.ts';

test('an up-to-date run leaves a stale freshness marker pending without handing it back immediately', async () => {
  await managedBrain(async ({ engine }) => {
    const marker = await upsertMarker(engine, {
      sourceId: 'default', intent: 'freshness', wantedHead: 'old-head', requestedBy: 'lock_busy',
    });

    const followUp = await settleRunMarkers(engine, 'default', [marker], {
      pulled: false, full: false, noProgress: true,
    });

    expect(followUp).toBeNull();
    expect((await readMarkers(engine, ['default'])).map(m => [m.generation, m.wanted_head])).toEqual([[marker.generation, 'old-head']]);
  });
}, 120_000);
