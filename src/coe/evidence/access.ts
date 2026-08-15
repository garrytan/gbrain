import type { AccessScope } from "../contracts/index.ts";
import type { EvidenceReadContext } from "./types.ts";

export function canReadEvidenceScope(scope: AccessScope, context: EvidenceReadContext): boolean {
  if (scope.brain_id !== context.brain_id) return false;
  const allowedSources = new Set(context.source_ids);
  if (!scope.source_ids.every((sourceId) => allowedSources.has(sourceId))) return false;
  if (scope.visibility === "public") return true;
  if (!context.principal_id) return false;
  return context.principal_id === scope.owner_principal || scope.reader_principals.includes(context.principal_id);
}
