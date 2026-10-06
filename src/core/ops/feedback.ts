/**
 * Retrieval feedback operations: `rate_answer` (CLI `gbrain rate`).
 * Never import from '../operations.ts' here (cycle).
 */
import type { Operation } from './contract.ts';
import { rateAnswer } from '../feedback/rate.ts';

const rate_answer: Operation = {
  name: 'rate_answer',
  area: 'search',
  outputRedaction: 'no_stored_text',
  mutating: true,
  writeInference: 'none',
  idempotent: true,
  description:
    'Rate how useful an answer\'s retrieved evidence was, so this brain ranks better next time (zero LLM calls). ' +
    'Pass the answer_id from a query/search/think/synthesize/recall response and rating 1-5, or rate single pages with ' +
    'pages: [{ ref: "source_id:slug", rating }]. Example: { answer_id: "ans_01J…", pages: [{ ref: "default:people/alice-example", rating: 1 }] }. ' +
    'Returns a receipt with each weight before/after; it never edits stored facts.',
  scope: 'write',
  params: {
    answer_id: { type: 'string', required: true, description: 'The ans_… id from the answer you are rating.' },
    rating: { type: 'number', description: 'Whole-answer rating 1-5 (omit when using pages).' },
    pages: {
      type: 'array',
      description: 'Per-page ratings: [{ ref: "source_id:slug", rating: 1-5 }]. Pages only; edges are not touched.',
      items: { type: 'object' },
    },
  },
  handler: async (ctx, p) => rateAnswer(ctx, { answer_id: p.answer_id, rating: p.rating, pages: p.pages }),
  cliHints: { name: 'rate', positional: ['answer_id', 'rating'] },
};

export const feedbackOperations: Operation[] = [rate_answer];
