/**
 * Query Intent Classifier tests
 */

import { describe, test, expect } from 'bun:test';
import { classifyQueryIntent, autoDetectDetail } from '../src/core/search/query-intent.ts';

describe('classifyQueryIntent', () => {
  describe('entity queries', () => {
    test('"Who is Pedro?" → entity', () => {
      expect(classifyQueryIntent('Who is Pedro?')).toBe('entity');
    });

    test('"What does Variant do?" → entity', () => {
      expect(classifyQueryIntent('What does Variant do?')).toBe('entity');
    });

    test('"Tell me about Brex" → entity', () => {
      expect(classifyQueryIntent('Tell me about Brex')).toBe('entity');
    });

    test('"What is the ownership economy?" → concept (RE-PINNED v0.46.15, Cat 13)', () => {
      // Was: → entity. That keyword tilt (kw×1.15 + exactMatch 1.25) on
      // definitional PARAPHRASES made hybrid lose to its own vector arm
      // (Cat 13: 47.0 vs 49.1 nDCG@5 on 500 paraphrase probes). Lowercase
      // subject + no proper noun = concept; "What is Stripe Atlas?" (mid-
      // sentence capital) stays entity.
      expect(classifyQueryIntent('What is the ownership economy?')).toBe('concept');
    });

    test('"Summarize Pedro" → entity', () => {
      expect(classifyQueryIntent('Summarize Pedro')).toBe('entity');
    });

    test('"Background on Variant Fund" → entity', () => {
      expect(classifyQueryIntent('Background on Variant Fund')).toBe('entity');
    });

    test('"What do we know about Brex?" → entity', () => {
      expect(classifyQueryIntent('What do we know about Brex?')).toBe('entity');
    });
  });

  describe('temporal queries', () => {
    test('"When did we last meet Pedro?" → temporal', () => {
      expect(classifyQueryIntent('When did we last meet Pedro?')).toBe('temporal');
    });

    test('"Recent updates on Variant" → temporal', () => {
      expect(classifyQueryIntent('Recent updates on Variant')).toBe('temporal');
    });

    test('"Meeting notes about Pedro" → temporal', () => {
      expect(classifyQueryIntent('Meeting notes about Pedro')).toBe('temporal');
    });

    test('"What\'s new with Brex?" → temporal', () => {
      expect(classifyQueryIntent("What's new with Brex?")).toBe('temporal');
    });

    test('"Last conversation with Jesse" → temporal', () => {
      expect(classifyQueryIntent('Last conversation with Jesse')).toBe('temporal');
    });

    test('"Timeline of Variant" → temporal', () => {
      expect(classifyQueryIntent('Timeline of Variant')).toBe('temporal');
    });

    test('"History with Pedro" → temporal', () => {
      expect(classifyQueryIntent('History with Pedro')).toBe('temporal');
    });

    test('"Updates from last month" → temporal', () => {
      expect(classifyQueryIntent('Updates from last month')).toBe('temporal');
    });

    test('"Latest on Brex" → temporal', () => {
      expect(classifyQueryIntent('Latest on Brex')).toBe('temporal');
    });

    test('"How long ago did we meet Jesse?" → temporal', () => {
      expect(classifyQueryIntent('How long ago did we meet Jesse?')).toBe('temporal');
    });

    test('"2024-03 Pedro" → temporal (date pattern)', () => {
      expect(classifyQueryIntent('2024-03 Pedro')).toBe('temporal');
    });
  });

  describe('event queries', () => {
    test('"Variant fund announcement" → event', () => {
      expect(classifyQueryIntent('Variant fund announcement')).toBe('event');
    });

    test('"Brex launched new product" → event', () => {
      expect(classifyQueryIntent('Brex launched new product')).toBe('event');
    });

    test('"Series B raised $50M" → event', () => {
      expect(classifyQueryIntent('Series B raised $50M')).toBe('event');
    });

    test('"Brex IPO" → event', () => {
      expect(classifyQueryIntent('Brex IPO')).toBe('event');
    });

    test('"What happened with the acquisition" → event', () => {
      expect(classifyQueryIntent('What happened with the acquisition')).toBe('event');
    });
  });

  describe('full context queries → temporal', () => {
    test('"Give me everything on Pedro" → temporal', () => {
      expect(classifyQueryIntent('Give me everything on Pedro')).toBe('temporal');
    });

    test('"Full history with Variant" → temporal', () => {
      expect(classifyQueryIntent('Full history with Variant')).toBe('temporal');
    });

    test('"All information about Brex" → temporal', () => {
      expect(classifyQueryIntent('All information about Brex')).toBe('temporal');
    });

    test('"Deep dive on AI philosophy" → temporal', () => {
      expect(classifyQueryIntent('Deep dive on AI philosophy')).toBe('temporal');
    });
  });

  describe('general queries', () => {
    test('"AI changes who gets to build" → general', () => {
      expect(classifyQueryIntent('AI changes who gets to build')).toBe('general');
    });

    test('"fintech payments infrastructure" → general', () => {
      expect(classifyQueryIntent('fintech payments infrastructure')).toBe('general');
    });

    test('"Pedro Brex" → general (bare entity name)', () => {
      expect(classifyQueryIntent('Pedro Brex')).toBe('general');
    });

    test('"crypto web3 ownership" → general', () => {
      expect(classifyQueryIntent('crypto web3 ownership')).toBe('general');
    });
  });
});

describe('autoDetectDetail', () => {
  test('entity queries → low', () => {
    expect(autoDetectDetail('Who is Pedro?')).toBe('low');
    expect(autoDetectDetail('What does Variant do?')).toBe('low');
  });

  test('temporal queries → high', () => {
    expect(autoDetectDetail('When did we last meet Pedro?')).toBe('high');
    expect(autoDetectDetail('Recent updates on Variant')).toBe('high');
  });

  test('event queries → high', () => {
    expect(autoDetectDetail('Variant fund announcement')).toBe('high');
  });

  test('general queries → undefined (default)', () => {
    expect(autoDetectDetail('AI changes who gets to build')).toBeUndefined();
    expect(autoDetectDetail('fintech payments')).toBeUndefined();
  });
});
