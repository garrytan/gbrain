import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { operations } from '../operations.ts';
import { OperationError, type AuthInfo } from '../ops/contract.ts';
import { hasScope, operationScopesAllowed } from '../scope.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { dispatchToolCall } from '../../mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from './identity.ts';
import { startPersistenceConsumer, assertPersistenceAccepting } from './service.ts';
import { isWriteErrorCode, isWriteReceipt } from './types.ts';
import type { PersistenceIpcProvider } from './ipc.ts';
import { runPersistenceAdministration } from './administration.ts';

/** Resident lifecycle owns the consumer; each connection proves its own durable registration. */
export async function createPersistenceIpcProvider(engine: BrainEngine, config: GBrainConfig): Promise<PersistenceIpcProvider> {
  for (const lane of ['cli', 'stdio'] as const) {
    try { await registerLocalWriter(engine, lane); }
    catch (error) {
      // Revocation persists across restart. Other principals can still use this owner.
      if (!(error instanceof OperationError && error.code === 'permission_denied')) throw error;
    }
  }
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  startPersistenceConsumer(engine, config);
  return { brainId: brain.brain_id, dispatch: request => withVerifiedLocalRegistration(engine, request.registration, async verified => {
    assertPersistenceAccepting(engine);
    if (request.brain_id !== brain.brain_id) throw new OperationError('permission_denied', 'This registration belongs to a different brain.');
    const operation = operations.find(op => op.name === request.operation);
    const localSkillAdministration = !verified.remote && verified.principal.kind === 'local_cli'
      && ['get_skill_policy', 'set_skill_policy', 'get_skill_retention', 'prune_skill_revisions', 'retain_skill_revision', 'import_skill_proposal'].includes(request.operation);
    if (!operation || (!localSkillAdministration && !hasScope(verified.grant.scopes, operation.scope ?? 'read'))
      || (verified.remote && !operationScopesAllowed(verified.grant.scopes, operation))
      || (verified.grant.operations !== null && !verified.grant.operations.includes(operation.name))) {
      throw new OperationError('permission_denied', 'The local writer grant excludes this operation.');
    }
    const sourceId = await resolveSourceId(engine, request.routing.source, request.routing.cwd, { skipLocalSignals: true });
    const unrestricted = verified.grant.sourceIds.includes('*');
    const sourceAllowed = (source: unknown) => typeof source === 'string' && (unrestricted || verified.grant.sourceIds.includes(source));
    if (!sourceAllowed(sourceId) || (request.params.source_id !== undefined && !sourceAllowed(request.params.source_id))) {
      throw new OperationError('permission_denied', 'The local writer grant excludes this source.');
    }
    // AuthInfo carries server-constructed read/fence ceilings; durable identity
    // remains in the verifier's async context, never a fabricated OAuth identity.
    const auth: AuthInfo = { token: '', clientId: verified.principal.id, scopes: [...verified.grant.scopes],
      sourceId, allowedOperations: verified.grant.operations, boundSlugPrefixes: verified.grant.slugPrefixes ?? undefined,
      allowedSources: unrestricted ? undefined : verified.grant.sourceIds };
    const params = !unrestricted && request.operation === 'get_page' && request.params.source_id === undefined
      ? { ...request.params, source_id: sourceId } : request.params;
    const result = await dispatchToolCall(engine, request.operation, params, {
      config, remote: verified.remote, transport: verified.remote ? 'stdio' : undefined, sourceId, auth,
      ...(unrestricted ? {} : { localFederatedSourceIds: verified.grant.sourceIds }),
    });
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    if (!result.isError) return body;
    const error = new OperationError(typeof body.error === 'string' ? body.error : 'unavailable',
      typeof body.message === 'string' ? body.message : 'The local operation could not complete.',
      typeof body.suggestion === 'string' ? body.suggestion : undefined);
    if (isWriteReceipt(body.write_request)) error.writeRequest = body.write_request;
    if (isWriteErrorCode(body.write_error)) error.writeError = body.write_error;
    if (body.protocol_version === 1) error.protocolVersion = 1;
    throw error;
  }), administer: request => withVerifiedLocalRegistration(engine, request.registration, async verified => {
    assertPersistenceAccepting(engine);
    if (request.brain_id !== brain.brain_id || verified.remote || verified.principal.kind !== 'local_cli') {
      throw new OperationError('permission_denied', 'Local administration requires this brain’s current trusted CLI registration.');
    }
    return runPersistenceAdministration(engine, request.operation, request.params, config);
  }) };
}
