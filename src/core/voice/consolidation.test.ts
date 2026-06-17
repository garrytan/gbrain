import { describe, test, expect } from 'bun:test';
import { InMemoryGraphAdapter } from '../graph/in-memory-adapter.ts';
import { consolidateVoiceSession } from './consolidation.ts';

describe('consolidateVoiceSession', () => {
  test('session with person:anna and company:acme tags creates 2 entities', async () => {
    const graph = new InMemoryGraphAdapter();
    const result = await consolidateVoiceSession(
      {
        transcript: 'Anna from Acme Corp discussed the project.',
        summary: 'Meeting with Anna from Acme.',
        tags: ['person:anna', 'company:acme'],
        source: 'voice',
      },
      graph,
    );

    expect(result.entities).toHaveLength(2);

    const personEntity = result.entities.find(e => e.slug === 'anna');
    expect(personEntity).toBeDefined();
    expect(personEntity!.type).toBe('person');

    const companyEntity = result.entities.find(e => e.slug === 'acme');
    expect(companyEntity).toBeDefined();
    expect(companyEntity!.type).toBe('company');

    expect(result.relations).toHaveLength(2);

    // Verify entities exist in graph
    const annaRelated = await graph.getRelatedEntities(
      result.relations[0].from,
    );
    expect(annaRelated).toHaveLength(2);
  });

  test('session with no tagged entities returns empty result', async () => {
    const graph = new InMemoryGraphAdapter();
    const result = await consolidateVoiceSession(
      {
        transcript: 'Just a general discussion.',
        summary: 'General discussion.',
        tags: ['general', 'meeting'],
        source: 'voice',
      },
      graph,
    );

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  test('graph failure does not crash consolidation', async () => {
    const failingGraph = {
      createEntity: async () => { throw new Error('DB connection failed'); },
      createRelation: async () => { throw new Error('DB connection failed'); },
    } as any;

    const result = await consolidateVoiceSession(
      {
        transcript: 'Anna from Acme Corp.',
        summary: 'Meeting.',
        tags: ['person:anna', 'company:acme'],
        source: 'voice',
      },
      failingGraph,
    );

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  test('created entities have low confidence (0.6)', async () => {
    const graph = new InMemoryGraphAdapter();
    const result = await consolidateVoiceSession(
      {
        transcript: 'Bob is working on the project.',
        summary: 'Bob project.',
        tags: ['person:bob'],
        source: 'voice',
      },
      graph,
    );

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].slug).toBe('bob');

    const sessionSlug = result.relations[0].from;
    const related = await graph.getRelatedEntities(sessionSlug);
    expect(related).toHaveLength(1);
    expect(related[0].slug).toBe('bob');

    // Verify relations have low confidence
    expect(result.relations[0].type).toBe('mentions');
  });

  test('relations are created from session to each entity', async () => {
    const graph = new InMemoryGraphAdapter();
    const result = await consolidateVoiceSession(
      {
        transcript: 'Carol from Beta Inc meeting.',
        summary: 'Carol meeting.',
        tags: ['person:carol', 'company:beta'],
        source: 'voice',
      },
      graph,
    );

    const sessionSlug = result.relations[0].from;
    expect(result.relations.every(r => r.from === sessionSlug)).toBe(true);
    expect(result.relations.every(r => r.type === 'mentions')).toBe(true);

    const related = await graph.getRelatedEntities(sessionSlug);
    expect(related).toHaveLength(2);

    const slugs = related.map(r => r.slug);
    expect(slugs).toContain('carol');
    expect(slugs).toContain('beta');
  });
});
