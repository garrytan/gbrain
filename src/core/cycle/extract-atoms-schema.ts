import type { ChatOpts } from '../ai/gateway.ts';

// v0.42+ TODO: read atom_type enum from active pack manifest at runtime.
export const ATOM_TYPES = [
  'insight', 'anecdote', 'quote', 'framework', 'statistic',
  'story_angle', 'strategy_angle', 'strategy', 'endorsement',
  'critique', 'collection',
] as const;

// Use an object root for strict-compatible endpoints. Optional metadata is
// nullable so constrained generation need not invent it; legacy array replies
// still pass through the extractor's existing tolerant parser.
export const ATOMS_RESPONSE_SCHEMA = {
  name: 'atoms_extraction',
  schema: {
    type: 'object',
    properties: {
      atoms: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            atom_type: { type: 'string', enum: [...ATOM_TYPES] },
            body: { type: 'string' },
            source_quote: { type: ['string', 'null'] },
            lesson: { type: ['string', 'null'] },
            concepts: { type: ['array', 'null'], items: { type: 'string' } },
            virality_score: { type: ['number', 'null'] },
            emotional_register: { type: ['string', 'null'] },
          },
          required: ['title', 'atom_type', 'body', 'source_quote', 'lesson', 'concepts', 'virality_score', 'emotional_register'],
          additionalProperties: false,
        },
      },
    },
    required: ['atoms'],
    additionalProperties: false,
  },
} satisfies NonNullable<ChatOpts['responseSchema']>;
