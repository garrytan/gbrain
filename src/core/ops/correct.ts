/**
 * correct (agent platform C2): save a standing rule and fix the fact it corrects in one call, with a receipt.
 * The work lives in src/core/rules/correct.ts; this file is the MCP and CLI contract. On the starter surface with
 * five short params; the rest are full-surface only (dispatch accepts them everywhere).
 */
import type { Operation } from './contract.ts';
import { CONTENT_ORIGIN_PARAM, WRITE_REQUEST_PARAM } from '../persistence/params.ts';

const correct: Operation = {
  name: 'correct',
  mutating: true,
  idempotent: true,
  writeInference: 'none',
  outputRedaction: 'no_stored_text',
  description: 'The user corrected you: saves their standing rule and replaces fact_id with corrected_fact (or withdraws it). Branch on state and next.',
  params: {
    rule: { type: 'string', description: 'The rule, in the user\'s words.' },
    fact_id: { type: 'string', description: 'The wrong fact.' },
    corrected_fact: { type: 'string', description: 'The right fact.' },
    entity: { type: 'string', description: 'Subject slug.' },
    receipt_id: { type: 'string', description: 'Alone: that receipt\'s status.' },
    scope: { type: 'string', enum: ['me', 'team'], description: 'me (default) or team.', fullSurfaceOnly: true },
    checks: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, expect: { type: 'array', items: { type: 'string' } }, reject: { type: 'array', items: { type: 'string' } } } },
      description: 'Regression checks for gbrain rules check: [{question, expect[], reject[]}].', fullSurfaceOnly: true },
    provenance: { type: 'string', description: 'Where the user said it.', fullSurfaceOnly: true },
    content_origin: { ...CONTENT_ORIGIN_PARAM, description: 'user_said only; tool_output and inferred are refused.' },
    resume: { type: 'boolean', description: 'With receipt_id: run the steps not yet committed.', fullSurfaceOnly: true },
    source_id: { type: 'string', description: 'Write source.', fullSurfaceOnly: true },
    request_id: { ...WRITE_REQUEST_PARAM, fullSurfaceOnly: true },
  },
  callShape: '{"rule":"Never call alice-example the CTO.","fact_id":"42","corrected_fact":"Alice-example is VP Engineering.","entity":"people/alice-example"}',
  scope: 'write',
  cliHints: { hidden: true },
  annotations: { title: 'correct', idempotentHint: true },
  handler: async (ctx, p) => (await import('../rules/correct.ts')).runCorrect(ctx, p),
};

export const correctOperations: Operation[] = [correct];
