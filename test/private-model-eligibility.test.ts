import { describe, expect, test } from 'bun:test';
import {
  filterPrivateModelPack,
  isPrivateModelEligibleText,
} from '../src/mcp/context-pack-handler.ts';
import type { TurnContextResult } from '../src/core/context/turn-context.ts';

const openAiFixture = ['sk', 'proj', 'syntheticfixturekey000000000000'].join('-');
const jwtFixture = ['eyJsyntheticAA', 'payloadfixtureBB', 'signaturefixtureCC'].join('.');

describe('private model eligibility', () => {
  test('ordinary private prose is eligible while explicit local-only markers fail closed', () => {
    expect(isPrivateModelEligibleText('prefers a quiet morning routine')).toBe(true);
    expect(isPrivateModelEligibleText('[gbrain:no-model] keep on host')).toBe(false);
    expect(isPrivateModelEligibleText('audience: local-only')).toBe(false);
    expect(isPrivateModelEligibleText('model_eligible: false')).toBe(false);
    expect(isPrivateModelEligibleText({ unexpected: 'shape' })).toBe(false);
  });

  test('credential, authentication, payment, and identity-secret examples are ineligible', () => {
    expect(isPrivateModelEligibleText(`api key: ${openAiFixture}`)).toBe(false);
    expect(isPrivateModelEligibleText('password: short-secret')).toBe(false);
    expect(isPrivateModelEligibleText(`Bearer ${jwtFixture}`)).toBe(false);
    expect(isPrivateModelEligibleText('card is 4242 4242 4242 4242')).toBe(false);
    expect(isPrivateModelEligibleText('ssn is 123-45-6789')).toBe(false);
  });

  test('mixed packs keep eligible facts and provenance while removing ineligible siblings', () => {
    const result: TurnContextResult = {
      mode: 'pack',
      text: 'pre-filter',
      pointers: [],
      factsCount: 4,
      facts: [
        {
          id: 1,
          fact: 'safe private preference',
          kind: 'preference',
          entity_slug: 'people/alice-example',
          context: 'conversation://fixture-safe',
          confidence: 0.9,
        },
        {
          id: 2,
          fact: `api key: ${openAiFixture}`,
          kind: 'fact',
          entity_slug: 'people/alice-example',
          context: 'conversation://fixture-secret',
          confidence: 0.9,
        },
        {
          id: 3,
          fact: '[gbrain:no-model] local observation',
          kind: 'fact',
          entity_slug: 'people/alice-example',
          context: 'conversation://fixture-local',
          confidence: 0.9,
        },
        {
          id: 4,
          fact: 'card is 4242 4242 4242 4242',
          kind: 'fact',
          entity_slug: 'people/alice-example',
          context: 'conversation://fixture-payment',
          confidence: 0.9,
        },
      ],
      cards: [],
      openThreads: [],
    };

    const filtered = filterPrivateModelPack(result);
    expect(filtered.factsCount).toBe(1);
    expect(filtered.facts?.map((f) => f.fact)).toEqual(['safe private preference']);
    expect(filtered.facts?.[0].context).toBe('conversation://fixture-safe');
    expect(filtered.text).toContain('safe private preference');
    expect(filtered.text).not.toContain('local observation');
    expect(filtered.text).not.toContain('4242');
  });

  test('unsafe nested fields and checkpoint links are removed before rendering', () => {
    const result: TurnContextResult = {
      mode: 'pack',
      text: 'pre-filter',
      pointers: [],
      factsCount: 0,
      facts: [],
      cards: [{
        entity: { slug: 'people/alice-example', title: 'Alice Example', type: 'person' },
        aka: ['Alice', '[no-model] local alias'],
        summary: 'safe summary',
        last_touched: { updated_at: null, last_retrieved_at: null, last_timeline_date: null },
        open_threads: [
          { kind: 'commitment', text: 'safe follow-up', date: null },
          { kind: 'commitment', text: 'password: short-secret', date: null },
        ],
        edges: [
          { type: 'works_at', direction: 'out', slug: 'companies/acme-example', context: null },
          { type: 'advises', direction: 'out', slug: 'companies/local-example', context: '[local-only]' },
        ],
        backlink_count: 0,
        active_fact_count: 0,
      }],
      openThreads: [
        { kind: 'commitment', text: 'safe follow-up', date: null },
        { kind: 'commitment', text: `Bearer ${jwtFixture}`, date: null },
      ],
      checkpointLinks: [
        { slug: 'sessions/safe', title: 'Safe checkpoint' },
        { slug: 'sessions/local', title: '[gbrain:no-model] local checkpoint' },
      ],
    };

    const filtered = filterPrivateModelPack(result);
    expect(filtered.cards?.[0].aka).toEqual(['Alice']);
    expect(filtered.cards?.[0].open_threads.map((t) => t.text)).toEqual(['safe follow-up']);
    expect(filtered.cards?.[0].edges.map((e) => e.type)).toEqual(['works_at']);
    expect(filtered.openThreads?.map((t) => t.text)).toEqual(['safe follow-up']);
    expect(filtered.checkpointLinks?.map((l) => l.slug)).toEqual(['sessions/safe']);
    expect(filtered.text).not.toContain('short-secret');
    expect(filtered.text).not.toContain('local checkpoint');
  });
});
