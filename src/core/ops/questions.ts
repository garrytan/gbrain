/**
 * questions_* ops: pinned questions (standing answers kept current from
 * evidence). Owner-private in v1: every op refuses callers that cannot read
 * private pages (src/core/questions/service.ts). On the full MCP surface that
 * registrations pin, not in STARTER_OPS; `gbrain questions <verb>` is the CLI.
 */
import type { Operation, ParamDef } from './contract.ts';

const EXEMPT = { exempt: 'owner-private pinned-question receipts: every questions_* op refuses callers that cannot read private pages' };
const ID: ParamDef = { type: 'string', required: true, description: 'Source-qualified id from questions_list, e.g. default:questions/<slug>.' };
const WAIT: ParamDef = { type: 'number', description: 'Max ms to wait for the answer (pin default 30000, refresh 120000; max 300000).' };

const questions_pin: Operation = {
  name: 'questions_pin',
  description: 'Pin a question: gbrain keeps a cited answer current from your notes and flags sentences whose evidence changed. Idempotent. Pins made over MCP stay inactive (paid refresh) until the owner activates them; returns the first answer when a key and consent exist, else awaiting_refresh with next_action.',
  params: {
    question: { type: 'string', description: 'The question (omit when passing id).' },
    scope: {
      type: 'object', description: 'Evidence scope; default: the current source.',
      properties: {
        source: { type: 'string', description: 'Source id.' },
        slug_prefix: { type: 'string', description: 'Only pages under this prefix, e.g. projects/.' },
        entity: { type: 'string', description: 'Entity page slug the question is about.' },
      },
    },
    id: { type: 'string', description: 'Existing pin id: re-pin or (owner, on the host) activate it.' },
    defer: { type: 'boolean', description: 'Skip the first answer.' },
    wait_ms: WAIT,
    publish: { type: 'boolean', description: 'Owner only: publish a draft-only pin.' },
  },
  mutating: true,
  writeInference: 'explicit_llm',
  idempotent: true,
  scope: 'write',
  outputRedaction: EXEMPT,
  annotations: { title: 'questions_pin', idempotentHint: true },
  handler: async (ctx, p) => (await import('../questions/service.ts')).pinQuestion(ctx, p),
};

const questions_list: Operation = {
  name: 'questions_list',
  description: 'List pinned questions with freshness, blocked reason and next action, plus fresh/stale/pending counts. Owner-capable connections only.',
  params: {
    source: { type: 'string', description: 'Only this source.' },
    include_archived: { type: 'boolean', description: 'Include unpinned (archived) questions.' },
  },
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: EXEMPT,
  annotations: { title: 'questions_list', readOnlyHint: true },
  handler: async (ctx, p) => (await import('../questions/service.ts')).listQuestions(ctx, p),
};

const questions_status: Operation = {
  name: 'questions_status',
  description: 'One pinned question: the answer with per-sentence stale flags, evidence watermark, last refresh, blocked reason, next action and verify step. Owner-capable connections only.',
  params: {
    id: ID,
    include_answer: { type: 'boolean', description: 'Include answer sentences (default true).' },
  },
  mutating: false,
  idempotent: true,
  scope: 'read',
  outputRedaction: EXEMPT,
  annotations: { title: 'questions_status', readOnlyHint: true },
  handler: async (ctx, p) => (await import('../questions/service.ts')).questionStatus(ctx, p),
};

const questions_refresh: Operation = {
  name: 'questions_refresh',
  description: 'Refresh a pinned answer now (a paid model call): re-retrieves current evidence and edits the answer, or recomputes with full or after deletions. A failed refresh keeps the previous answer with its stale flags.',
  params: {
    id: ID,
    full: { type: 'boolean', description: 'Recompute from scratch.' },
    wait_ms: WAIT,
  },
  mutating: true,
  writeInference: 'explicit_llm',
  idempotent: false,
  scope: 'write',
  outputRedaction: EXEMPT,
  annotations: { title: 'questions_refresh' },
  handler: async (ctx, p) => (await import('../questions/service.ts')).refreshQuestion(ctx, p),
};

const questions_unpin: Operation = {
  name: 'questions_unpin',
  description: 'Unpin a question: refreshes stop and its page is archived (your notes on it are kept). Idempotent.',
  params: { id: ID },
  mutating: true,
  writeInference: 'none',
  idempotent: true,
  scope: 'write',
  outputRedaction: EXEMPT,
  annotations: { title: 'questions_unpin', idempotentHint: true },
  handler: async (ctx, p) => (await import('../questions/service.ts')).unpinQuestion(ctx, p),
};

export const questionsOperations: Operation[] = [questions_pin, questions_list, questions_status, questions_refresh, questions_unpin];
