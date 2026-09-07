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
 * null ONLY that self-referential attribution. The predicate is tested directly;
 * the choke-point wiring (incl. the #4755 null-like-string gate) is pinned by
 * driving `extractFactsFromTurnWithOutcome` through the chat-transport stub, so
 * the assertions hit the real candidate loop, never a file-local mirror of it.
 *
 * POSITIVE (bug repro — fails before the fix, the symbol/gate did not exist):
 *   anonymous-speaker label → true → loop nulls entity.
 * NEGATIVE (over-broad guard — the fix must not touch these):
 *   third-person entity ("acme") and named speaker ("Anton") → false → entity
 *   is preserved exactly as upstream does today.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { isUnknownSpeakerLabel, extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';

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

describe('gate semantics at the choke point (extractFactsFromTurnWithOutcome)', () => {
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  // Drives the REAL candidate loop: the chat-transport stub returns one
  // candidate per entity and we read back the `entity_slug` the extractor
  // emitted. No engine (every config reader defaults without one), no network.
  async function emittedEntitySlugs(entities: Array<string | null>): Promise<Array<string | null>> {
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({
        facts: entities.map((entity, i) => ({
          fact: `acme-example shipped release ${i + 1} of the widget`,
          kind: 'fact',
          entity,
          confidence: 1.0,
          notability: 'medium',
        })),
      }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    }));
    const outcome = await extractFactsFromTurnWithOutcome({ turnText: 'a conversation turn', source: 'test' });
    if (!outcome.ok) throw new Error(`extraction skipped: ${outcome.reason}`);
    expect(outcome.facts.length).toBe(entities.length);
    return outcome.facts.map(f => f.entity_slug);
  }

  test('(#4755) null-like placeholder strings → entity nulled; real names preserved', async () => {
    expect(await emittedEntitySlugs(['null', 'None', 'n/a', 'undefined', 'people/alice-example', 'Nullsoft']))
      .toEqual([null, null, null, null, 'people/alice-example', 'Nullsoft']);
  });

  test('(a) first-person self-assertion from anonymous speaker → entity nulled', async () => {
    // LLM echoed the speaker label as the entity for "Speaker A: I'm joining Acme".
    expect(await emittedEntitySlugs(['Speaker A'])).toEqual([null]);
  });

  test('(b) third-person fact from anonymous speaker → entity preserved', async () => {
    // "Speaker A: Acme raised $5M" → entity=acme is CORRECT regardless of speaker.
    expect(await emittedEntitySlugs(['acme', 'companies/acme'])).toEqual(['acme', 'companies/acme']);
  });

  test('first-person assertion from a NAMED speaker → attribution preserved', async () => {
    // "Charlie: I'm joining Acme" → entity=people/charlie-example is legitimate.
    expect(await emittedEntitySlugs(['people/charlie-example'])).toEqual(['people/charlie-example']);
  });
});
