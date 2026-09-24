import type { Operation } from './contract.ts';
import { joinBrain, leaveBrain, syncBrain } from '../shared-skills/membership.ts';

export const brainMembershipOperations: Operation[] = [
  {
    name: 'join_brain', description: 'Enroll this authenticated principal to follow approved shared skills. Shared credentials are one principal. Never grants memory-write or editor authority.',
    scope: 'read', mutating: true, requiredScopes: ['skills_member_self'],
    cliHints: { name: 'join-brain', positional: [] },
    params: { adapter: { type: 'string', required: true, description: 'Registered harness adapter ID for this authenticated installation.' }, follow_policy: { type: 'object', required: true, description: 'Explicit approved:true and optional source_ids narrowing.' } },
    handler: (ctx, params) => joinBrain(ctx, params as Parameters<typeof joinBrain>[1]),
  },
  {
    name: 'sync_brain_skills', description: 'Get a complete authorized shared-skills view and optionally record an own issued-batch delivery acknowledgment. Unavailable is never an empty catalog.',
    scope: 'read', mutating: true, requiredScopes: ['skills_member_self'],
    cliHints: { name: 'sync-brain-skills', positional: [] },
    params: { installation_id: { type: 'string', required: true, description: 'Own server-issued installation UUID returned by join_brain.' }, enrollment_epoch: { type: 'number', required: true, description: 'Current enrollment epoch returned by join_brain; stale epochs cannot reactivate membership.' }, acknowledgment: { type: 'object', description: 'Optional issued batch token and exact delivery evidence for this installation, never proof of native use.' } },
    handler: (ctx, params) => syncBrain(ctx, params as Parameters<typeof syncBrain>[1]),
  },
  {
    name: 'leave_brain', description: 'Stop only this principal’s enrollment. Does not revoke credentials or prove native cached instructions were disabled.',
    scope: 'read', mutating: true, requiredScopes: ['skills_member_self'],
    cliHints: { name: 'leave-brain', positional: [] },
    params: { installation_id: { type: 'string', required: true, description: 'Own server-issued installation UUID to leave.' }, enrollment_epoch: { type: 'number', required: true, description: 'Current enrollment epoch; a previous installation cannot leave its replacement.' } },
    handler: (ctx, params) => leaveBrain(ctx, params as Parameters<typeof leaveBrain>[1]),
  },
];
