/** CLI-only commands may parse/read input before lazily connecting to a local engine. */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';
import { OperationError } from '../core/ops/contract.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { maybeDelegateLocalOperation } from '../core/persistence/local-client.ts';
import { PersistenceIpcTransportError } from '../core/persistence/ipc.ts';
import { RemoteMcpError } from '../core/mcp-client.ts';

export async function reportPersistenceCliError(error: unknown, json = false,
  out: (payload: string) => Promise<void> = writeStdoutFinal): Promise<boolean> {
  if (!(error instanceof OperationError || error instanceof PersistenceIpcTransportError
    || error instanceof RemoteMcpError && (error.detail?.request_id || error.detail?.write_request))) return false;
  const detail = error.toJSON();
  if (json) await out(JSON.stringify(detail, null, 2) + '\n');
  console.error(error instanceof OperationError || error instanceof RemoteMcpError
    ? `Error [${'write_error' in detail && detail.write_error || detail.error}]: ${detail.message}` : error.message);
  if (detail.suggestion) console.error(`Fix: ${detail.suggestion}`);
  const receipt = 'write_request' in detail ? detail.write_request : undefined;
  const requestId = receipt?.request_id ?? ('request_id' in detail ? detail.request_id : undefined);
  if (requestId) console.error(`Request: ${requestId}${receipt ? ` (${receipt.state})` : ''}`);
  setCliExitVerdict(1);
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
