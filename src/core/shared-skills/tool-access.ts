import type { OperationContext } from '../ops/contract.ts';
import { enforceBoundClientOpAllowList } from '../ops/context.ts';
import { operationScopesAllowed } from '../scope.ts';
import { currentVerifiedLocalWriter } from '../persistence/identity.ts';
import { allowedOpNames } from '../../mcp/surface.ts';
import { disabledOpsForPublishGates } from '../../mcp/publish-gates.ts';

export async function sharedSkillToolAccess(ctx: OperationContext): Promise<string[]> {
  const { operations } = await import('../operations.ts');
  if (ctx.remote === false) return operations.map(op => op.name).sort();
  const scopes = ctx.auth?.scopes ?? currentVerifiedLocalWriter()?.grant.scopes ?? [];
  const grant = ctx.auth?.allowedOperations ?? currentVerifiedLocalWriter()?.grant.operations;
  const surface = allowedOpNames(operations, ctx.auth?.effectiveSurface ?? 'full');
  const disabled = await disabledOpsForPublishGates(ctx.engine, ctx.config);
  return operations.filter(op => {
    if (op.localOnly || !surface.has(op.name) || disabled.has(op.name) || !operationScopesAllowed(scopes, op) || grant != null && !grant.includes(op.name)) return false;
    try { enforceBoundClientOpAllowList(ctx.auth, op); } catch { return false; }
    return true;
  }).map(op => op.name).sort();
}
