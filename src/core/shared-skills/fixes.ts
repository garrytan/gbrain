/**
 * Agent contract v1 (B10): the read-only next steps shared-skill refusals
 * point at. Plain `Action` builders; `command`/`next` are rendered per caller.
 */
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';

/** Reads one skill (its current head, or an exact revision) with its revision and file manifest. */
export function skillHeadFix(sourceId: string, packId: string, name: string, revision?: string): Action {
  const at = revision ? ['--revision', revision] : [];
  return readFix(revision
    ? `Reads revision ${revision} of ${packId}/${name} on source ${sourceId} with its approved file manifest.`
    : `Reads the current head revision of ${packId}/${name} on source ${sourceId}; resubmit against it with a new request_id.`, {
    argv: ['gbrain', 'skill', '--schema-version', '2', '--source-id', sourceId, '--pack-id', packId, '--name', name, ...at],
    mcp: { tool: 'get_skill', arguments: { schema_version: 2, source_id: sourceId, pack_id: packId, name, ...(revision ? { revision } : {}) } },
  });
}

/** Lists the authorized shared-skill catalog (one source when known) with qualified ids, incarnations and head revisions. */
export function catalogFix(sourceId?: string): Action {
  const scope = sourceId ? ['--source-id', sourceId] : [];
  return readFix(`Lists ${sourceId ? `source ${sourceId}'s` : 'the authorized'} shared skills with their qualified_id, source_incarnation, pack_id and head revisions.`, {
    argv: ['gbrain', 'skills', '--schema-version', '2', ...scope],
    mcp: { tool: 'list_skills', arguments: { schema_version: 2, ...(sourceId ? { source_id: sourceId } : {}) } },
  });
}

/** Reads a source's publication policy and epoch (the review step before set_skill_policy). */
export function policyFix(sourceId: string): Action {
  return readFix(`Shows source ${sourceId}'s owner-approved publication policy and its epoch; widening it is the publisher's decision (set_skill_policy), never the editor's.`, {
    argv: ['gbrain', 'skill-policy', '--source-id', sourceId],
    mcp: { tool: 'get_skill_policy', arguments: { source_id: sourceId } },
  });
}
