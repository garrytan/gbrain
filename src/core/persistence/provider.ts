import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { operations } from '../operations.ts';
import { opError, OperationError, type AuthInfo } from '../ops/contract.ts';
import { hasScope, operationScopesAllowed } from '../scope.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { dispatchToolCall } from '../../mcp/dispatch.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from './identity.ts';
import { startPersistenceConsumer, assertPersistenceAccepting } from './service.ts';
import { isWriteErrorCode, isWriteReceipt } from './types.ts';
import { LOCAL_CLI_OWNER_OPERATIONS, type PersistenceIpcProvider } from './ipc.ts';
import { runPersistenceAdministration } from './administration.ts';
import { boundedWriteWaitMs } from './write-wait.ts';
export { residentPersistenceConfig } from './local-client.ts';
import { projectionBacklog } from '../page-state/projections.ts';
import { trustedCliRequired } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';

const localWritersFix: Action = { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'], consent: [], actor: 'agent',
  why: 'Shows this brain\'s local writer registrations with their grants, read-only.', requires_exclusive: false };

/**
 * localOnly operations the verified local CLI may run through the resident
 * owner: dispatched with the `stdio` locality marker so the localOnly
 * backstop admits them; remote principals never get it.
 */
const LOCAL_CLI_LOCAL_ONLY_OPS = new Set(['takes_remove', 'takes_rebuild']);

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
  return { brainId: brain.brain_id, projectionStatus: () => projectionBacklog(engine), dispatch: request => withVerifiedLocalRegistration(engine, request.registration, async verified => {
    assertPersistenceAccepting(engine);
    if (request.brain_id !== brain.brain_id) {
      throw opError('permission_denied', 'This registration belongs to a different brain.',
        'The CLI sent a writer registration for another brain to this brain\'s owner. Select the intended brain with --brain; registering this CLI on this brain is a credentials step the user approves.',
        { fix: localWritersFix });
    }
    const operation = operations.find(op => op.name === request.operation);
    const localSkillAdministration = !verified.remote && verified.principal.kind === 'local_cli'
      && (['get_skill_policy', 'set_skill_policy', 'get_skill_retention', 'prune_skill_revisions', 'retain_skill_revision', 'import_skill_proposal'].includes(request.operation)
        || LOCAL_CLI_OWNER_OPERATIONS.has(request.operation));
    if (!operation || (!localSkillAdministration && !hasScope(verified.grant.scopes, operation.scope ?? 'read'))
      || (verified.remote && !operationScopesAllowed(verified.grant.scopes, operation))
      || (verified.grant.operations !== null && !verified.grant.operations.includes(operation.name))) {
      throw opError('permission_denied', 'The local writer grant excludes this operation.',
        `This CLI's writer grant does not cover ${request.operation}. Review the grant; widening it with gbrain auth local-writer register --replace is a credentials change the user approves.`,
        { fix: localWritersFix });
    }
    const sourceId = await resolveSourceId(engine, request.routing.source, request.routing.cwd, { skipLocalSignals: true });
    const unrestricted = verified.grant.sourceIds.includes('*');
    const sourceAllowed = (source: unknown) => typeof source === 'string' && (unrestricted || verified.grant.sourceIds.includes(source));
    if (!sourceAllowed(sourceId) || (request.params.source_id !== undefined && !sourceAllowed(request.params.source_id))) {
      throw opError('permission_denied', 'The local writer grant excludes this source.',
        `This CLI's writer grant does not cover source ${String(request.params.source_id ?? sourceId)}. Use a source the grant lists; widening it is a credentials change the user approves.`,
        { fix: localWritersFix });
    }
    // AuthInfo carries server-constructed read/fence ceilings; durable identity
    // remains in the verifier's async context, never a fabricated OAuth identity.
    const auth: AuthInfo = { token: '', clientId: verified.principal.id, scopes: [...verified.grant.scopes],
      sourceId, allowedOperations: verified.grant.operations, boundSlugPrefixes: verified.grant.slugPrefixes ?? undefined,
      allowedSources: unrestricted ? undefined : verified.grant.sourceIds };
    const params = !unrestricted && request.operation === 'get_page' && request.params.source_id === undefined
      ? { ...request.params, source_id: sourceId } : request.params;
    // `gbrain transcripts recent` through the live owner: the verified local CLI reads the host's transcript
    // files directly, as it does without a serve (localOnly ops never dispatch off the stdio pipe).
    if (request.operation === 'get_recent_transcripts') {
      if (verified.remote || verified.principal.kind !== 'local_cli') throw trustedCliRequired('Raw transcripts are read only by this host\'s trusted CLI.');
      const p = request.params;
      return (await import('../transcripts.ts')).listRecentTranscripts(engine, { days: typeof p.days === 'number' ? p.days : undefined,
        summary: typeof p.summary === 'boolean' ? p.summary : undefined, limit: typeof p.limit === 'number' ? p.limit : undefined });
    }
    const localCliLocalOnly = !verified.remote && verified.principal.kind === 'local_cli' && LOCAL_CLI_LOCAL_ONLY_OPS.has(request.operation);
    const writeWaitMs = boundedWriteWaitMs(request.write_wait_ms);
    const result = await dispatchToolCall(engine, request.operation, params, {
      config, remote: verified.remote, transport: verified.remote || localSkillAdministration || localCliLocalOnly ? 'stdio' : undefined, sourceId, auth,
      ...(writeWaitMs !== undefined ? { writeWaitMs } : {}),
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
      throw trustedCliRequired('Local administration requires this brain’s current trusted CLI registration.');
    }
    return runPersistenceAdministration(engine, request.operation, request.params, config);
  }) };
}
