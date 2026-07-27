/**
 * Unknown-speaker attribution gate (fix(facts)).
 *
 * The conversation-fact extractor renders turns as `${speaker} (${ts}): ${text}`.
 * `confidence` scores confidence-in-the-CLAIM, not confidence-in-WHO-said-it, so
 * a first-person self-assertion from an anonymous speaker ("Speaker A: I'm
 * joining Acme") could come back with the speaker label echoed as `entity` — a
 * confident attribution to someone we cannot identify.
 *
 * `isUnknownSpeakerLabel` is the deterministic gate the candidate loop uses to
 * null ONLY that self-referential attribution. We test the pure predicate
 * directly (the full extractor loop needs a live LLM; mirroring the existing
 * facts-extract tests, we never call a model here).
 *
 * POSITIVE (bug repro — fails before the fix, the symbol/gate did not exist):
 *   anonymous-speaker label → true → loop nulls entity.
 * NEGATIVE (over-broad guard — the fix must not touch these):
 *   third-person entity ("acme") and named speaker ("Anton") → false → entity
 *   is preserved exactly as upstream does today.
 */

import { describe, test, expect } from 'bun:test';
import { isUnknownSpeakerLabel } from '../src/core/facts/extract.ts';

describe('isUnknownSpeakerLabel — POSITIVE (anonymous-speaker tokens → nulled)', () => {
  const anonymous = [
    'Speaker A',
    'Speaker B',
    'Speaker Z9', // letter+digits diarizer id (gbrain's own parser fixture)
    'Speaker 1',
    'Speaker 12',
    'SPEAKER_00',
    'speaker_3',
    'Participant 2',
    'participant 10',
    '**Participant 2:**', // markdown-decorated, colon-suffixed
    'spk_0',
    'spk_15',
    'Other',
    'Unknown',
    'Guest',
    'unknown', // case-insensitive
    'GUEST',
  ];
  for (const label of anonymous) {
    test(`"${label}" is an unknown-speaker label`, () => {
      expect(isUnknownSpeakerLabel(label)).toBe(true);
    });
  }
});

describe('isUnknownSpeakerLabel — NEGATIVE (real entities preserved; guard against over-broad)', () => {
  const real = [
    // Third-person entities from an anonymous-speaker turn MUST survive.
    'acme',
    'companies/acme',
    'people/vica',
    'Vica',
    'travel',
    // A named speaker's own attribution MUST survive.
    'Anton',
    'people/anton-senkovskiy',
    'Anton Senkovskiy',
    // Near-miss strings that must NOT be swept up by the patterns.
    // The 2-token "Speaker <Surname>" cases are the sharp ones: an earlier
    // `^speaker [a-z0-9]+$` draft nulled these, destroying real attribution.
    'Speaker Pelosi', // Speaker of the House — a real third-person entity
    'Speaker Deck', // real product (slideshare-style)
    'Speaker Series', // an event/entity name
    'Speaker Systems Inc', // company that happens to start with "Speaker"
    'Guesthouse Ventures', // not the bare "Guest" token
    'Participant Capital', // not "Participant <n>"
    'Otherwise Labs',
    null,
    undefined,
    '',
    '   ',
  ];
  for (const label of real) {
    test(`${JSON.stringify(label)} is NOT an unknown-speaker label`, () => {
      expect(isUnknownSpeakerLabel(label)).toBe(false);
    });
  }
});

describe('gate semantics at the choke point (entity mapping)', () => {
  // Mirrors the exact expression in extractFactsFromTurn's candidate loop:
  //   entity_slug: isUnknownSpeakerLabel(candidate.entity) ? null : (candidate.entity ?? null)
  const mapEntity = (entity: string | null | undefined): string | null =>
    isUnknownSpeakerLabel(entity) ? null : (entity ?? null);

  test('(a) first-person self-assertion from anonymous speaker → entity nulled', () => {
    // LLM echoed the speaker label as the entity for "Speaker A: I'm joining Acme".
    expect(mapEntity('Speaker A')).toBeNull();
  });

  test('(b) third-person fact from anonymous speaker → entity preserved', () => {
    // "Speaker A: Acme raised $5M" → entity=acme is CORRECT regardless of speaker.
    expect(mapEntity('acme')).toBe('acme');
    expect(mapEntity('companies/acme')).toBe('companies/acme');
  });

  test('first-person assertion from a NAMED speaker → attribution preserved', () => {
    // "Anton: I'm joining Acme" → entity=Anton is legitimate.
    expect(mapEntity('Anton')).toBe('Anton');
  });
});
