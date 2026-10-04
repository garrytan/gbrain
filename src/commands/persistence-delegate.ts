/** CLI-only commands may parse/read input before lazily connecting to a local engine. */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { OperationError } from '../core/ops/contract.ts';
import { finishCliTeardown, noteRenderedErrorCode, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { RemoteMcpError } from '../core/mcp-client.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { PENDING_WRITE_EXIT_CODE } from '../core/exit-codes.ts';
import { acceptPendingRequested, pendingReceiptOf, pollCommand, WRITE_EXIT_DOCS, writeErrorExitCode } from '../core/persistence/write-wait.ts';
import { cliRenderContext, toAgentError } from '../core/agent-output.ts';
import { cliCommandOf } from '../cli/cli-error.ts';

export async function reportPersistenceCliError(error: unknown, json = false,
  out: (payload: string) => Promise<void> = writeStdoutFinal): Promise<boolean> {
  if (!(error instanceof OperationError || error instanceof PersistenceIpcTransportError
    || error instanceof RemoteMcpError && (error.detail?.request_id || error.detail?.write_request))) return false;
  const detail = error.toJSON();
  // #5232: an admitted pending write is not a failure; it exits
  // PENDING_WRITE_EXIT_CODE (0 with --accept-pending) and names how to poll.
  const pending = pendingReceiptOf(error);
  const acceptPending = acceptPendingRequested(getCliOptions().acceptPending);
  if (json) {
    // Legacy keys lead and keep their values; the v1 envelope fields (code, fix, docs_cmd, class, retryable,
    // notices, contract_version) come from the shared renderer, as renderCliError writes them (cli-error.ts pattern).
    const legacy: Record<string, unknown> = pending ? { ...detail, request_id: pending.request_id, state: pending.state,
      poll_command: pollCommand(pending.request_id) } : { ...detail };
    const envelope = toAgentError(error, { transport: 'cli', command: cliCommandOf(), render: cliRenderContext() });
    noteRenderedErrorCode(envelope.code);
    const doc = { ...legacy, ...Object.fromEntries(Object.entries(envelope).filter(([, v]) => v !== undefined)), ...legacy };
    await out(JSON.stringify(doc, null, 2) + '\n');
  }
  console.error(pending ? `Pending [write_pending]: ${detail.message} It may still commit.`
    : error instanceof OperationError || error instanceof RemoteMcpError
      ? `Error [${'write_error' in detail && detail.write_error || detail.error}]: ${detail.message}` : error.message);
  if (detail.suggestion) console.error(`Fix: ${detail.suggestion}`);
  const receipt = 'write_request' in detail ? detail.write_request : undefined;
  const requestId = receipt?.request_id ?? ('request_id' in detail ? detail.request_id : undefined);
  if (requestId) console.error(`Request: ${requestId}${receipt ? ` (${receipt.state})` : ''}`);
  if (pending) {
    console.error(`Poll: ${pollCommand(pending.request_id)}`);
    if (!acceptPending) console.error(`Exit ${PENDING_WRITE_EXIT_CODE}: accepted, not yet committed. Wait longer with --wait <seconds>, or pass --accept-pending to exit 0 (${WRITE_EXIT_DOCS}).`);
  }
  setCliExitVerdict(writeErrorExitCode(error, acceptPending));
  return true;
}

/** Shared operation CLI lane; false alone authorizes the caller's normal connect path. */
export async function runDelegatedCliOperation(
  operation: string,
  params: Record<string, unknown>,
  config: GBrainConfig | null,
  options: { brain?: string | null; timeoutMs?: number },
  render: (operation: string, result: unknown, params: Record<string, unknown>) => string,
): Promise<boolean> {
  try {
    const delegated = await maybeDelegateLocalOperation(operation, params, config, options);
    if (!delegated.handled) return false;
    const output = render(operation, delegated.result, params);
    if (output) await writeStdoutFinal(output);
    if ((delegated.result as { status?: unknown } | null)?.status === 'error') setCliExitVerdict(1);
    return true;
  } catch (error) {
    if (await reportPersistenceCliError(error, params.json === true)) return true;
    throw error;
  }
}

export async function runDeferredPersistenceCommand(
  command: 'capture' | 'forget' | 'call' | 'sources' | 'takes',
  args: string[],
  connect: () => Promise<BrainEngine>,
): Promise<void> {
  // A3: refusing to remove or archive the default source is invalid input (exit 2), as on
  // the unmanaged lane; the write lane's verdict would be 1.
  if (command === 'sources' && ['remove', 'archive', 'purge'].includes(args[0] ?? '') && args[1] === 'default') {
    const { exitCliError, usageError } = await import('../cli/cli-error.ts');
    exitCliError(usageError('The default source cannot be removed or archived.',
      'The default source holds the brain\'s primary pages and always stays registered; remove or archive a named source instead.',
      { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the named sources that can be removed or archived.' } }), 'sources');
  }
  let connected: BrainEngine | null = null;
  const getEngine = async () => connected ??= await connect();
  try {
    if (command === 'takes') {
      const { runTakesMutation } = await import('./takes-mutation.ts');
      await runTakesMutation(getEngine, args);
    } else if (command === 'sources') {
      if (args[0] === 'reconcile') {
        const { runReconcileCli } = await import('./source-reconcile.ts');
        await runReconcileCli(args.slice(1));
      } else if (args[0] === 'writer') {
        const { runPersistenceAdminCli } = await import('./persistence-admin.ts');
        await runPersistenceAdminCli('writer', args.slice(1));
      } else {
        const { runSourceLifecycleCli } = await import('./sources-lifecycle.ts');
        await runSourceLifecycleCli(args, getEngine);
      }
    } else if (command === 'capture') {
      const { runCapture } = await import('./capture.ts');
      await runCapture(null, args, { getEngine });
    } else if (command === 'forget') {
      const { runForget } = await import('./recall.ts');
      await runForget(getEngine, args);
    } else {
      const { runCall } = await import('./call.ts');
      await runCall(getEngine, args);
    }
  } finally {
    if (connected) await finishCliTeardown({ engine: connected, drainTimeoutMs: 1000 });
  }
}
