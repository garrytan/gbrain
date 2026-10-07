import type { ParamDef } from '../ops/contract.ts';

/** Capture input sugar stays data; the owner materializes generated fields once. */
export const CAPTURE_EVENT_PARAMS: Record<string, ParamDef> = {
  who: { type: 'string', description: 'Event: comma-separated entity slugs.' },
  what: { type: 'string', description: 'Event.' },
  where: { type: 'string', description: 'Event place.' },
  kind: { type: 'string', description: 'Event kind.' },
  depth: { type: 'string', description: 'Event depth page to link.' },
};
import { WRITE_REQUEST_STATES, WRITE_HEALTH_REASONS, WRITE_HEALTH_ASSESSMENTS, WRITE_HEALTH_ACTIONS } from './types.ts';

/** Leaf definitions: safe to import while the frozen verb registry is evaluating.
 * Runtime validators belong in separate modules; importing OperationError here
 * creates a params -> contract -> verbs -> params initialization cycle.
 */
export const WRITE_REQUEST_PARAM: ParamDef = {
  type: 'string',
  description: 'Optional; reuse only to retry.',
};

/** #6007: transport-only long-poll; never stored with the write or compared on replay. */
export const WIRE_WRITE_WAIT_MAX_MS = 30_000;
export const WRITE_WAIT_PARAM: ParamDef = {
  type: 'number',
  description: `Commit wait ms (0-${WIRE_WRITE_WAIT_MAX_MS}, default 5000).`,
};

export const PAGE_MUTATION_PARAMS: Record<string, ParamDef> = {
  source_id: {
    type: 'string',
    description: 'Write source.',
  },
  expected_revision: {
    type: 'string',
    description: 'Revision read; omit to create.',
  },
  force: {
    type: 'boolean',
    description: 'Ignore the revision.',
  },
  request_id: WRITE_REQUEST_PARAM,
};

/** Additive response schema shared by frozen memory-verb success and error envelopes. */
export const WRITE_RECEIPT_SCHEMA = {
  type: 'object',
  required: ['request_id', 'state', 'retry_after_ms'],
  properties: {
    request_id: { type: 'string' },
    state: { type: 'string', enum: [...WRITE_REQUEST_STATES] },
    retry_after_ms: { type: ['integer', 'null'] },
    revision: { type: 'string' },
    compacted: { type: 'boolean' },
    outcome: { type: 'object' },
    persistence: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['filesystem', 'database'] },
        file_written: { type: 'boolean' },
        git_state: { type: 'string' },
      },
    },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    diagnostic: {
      type: 'object', required: ['age_ms', 'assessment', 'reason', 'next_action'],
      properties: {
        age_ms: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        observed_at: { type: 'string', format: 'date-time' },
        assessment: { type: 'string', enum: [...WRITE_HEALTH_ASSESSMENTS] },
        reason: { type: 'string', enum: [...WRITE_HEALTH_REASONS] },
        next_action: { type: 'string', enum: [...WRITE_HEALTH_ACTIONS] },
      },
    },
  },
};
