import type { GraphRepository } from '../graph/types.ts';
import type { MemoryNode, MemoryType, Relation } from '../domain.ts';

export interface ConsolidationResult {
  entities: Array<{ slug: string; type: string }>;
  relations: Array<{ from: string; to: string; type: string }>;
}

function generateSlug(transcript: string, source: string): string {
  const hash = simpleHash(transcript + source);
  return `voice-session-${hash}`;
}

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const TAG_TO_MEMORY_TYPE: Record<string, MemoryType> = {
  person: 'person',
  company: 'company',
  project: 'project',
};

function parseTagEntities(tags: string[]): Array<{ type: MemoryType; name: string }> {
  const result: Array<{ type: MemoryType; name: string }> = [];
  for (const tag of tags) {
    const match = tag.match(/^(person|company|project):(.+)$/);
    if (match) {
      const type = TAG_TO_MEMORY_TYPE[match[1]];
      if (type) {
        result.push({ type, name: match[2].trim() });
      }
    }
  }
  return result;
}

export async function consolidateVoiceSession(
  session: { transcript: string; summary: string; tags: string[]; source: string },
  graph: GraphRepository,
): Promise<ConsolidationResult> {
  const entities: Array<{ slug: string; type: string }> = [];
  const relations: Array<{ from: string; to: string; type: string }> = [];

  const taggedEntities = parseTagEntities(session.tags);
  if (taggedEntities.length === 0) {
    return { entities, relations };
  }

  const sessionSlug = generateSlug(session.transcript, session.source);
  const now = new Date().toISOString();

  for (const te of taggedEntities) {
    const slug = te.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const node: MemoryNode = {
      id: slug,
      slug,
      type: te.type,
      title: te.name,
      summary: '',
      source: session.source,
      confidence: 0.6,
      consent: false,
      tags: [],
      created_at: now,
      last_verified_at: now,
      metadata: {},
    };

    try {
      await graph.createEntity(node);
      entities.push({ slug, type: te.type });
    } catch (err) {
      console.error(`Failed to create entity ${slug}:`, err);
      continue;
    }

    const relation: Relation = {
      from_slug: sessionSlug,
      to_slug: slug,
      relation_type: 'mentions',
      confidence: 0.6,
      context: `Voice session mentions ${te.type}:${te.name}`,
      source: session.source,
      created_at: now,
    };

    try {
      await graph.createRelation(relation);
      relations.push({ from: sessionSlug, to: slug, type: 'mentions' });
    } catch (err) {
      console.error(`Failed to create relation from ${sessionSlug} to ${slug}:`, err);
    }
  }

  return { entities, relations };
}
