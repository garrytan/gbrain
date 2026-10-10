/** Engine-free handoff to the authenticated local owner; never sends host paths over HTTP. */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../core/config.ts';
import { inspectLockHolder } from '../core/pglite-lock.ts';
import { residentPersistenceConfig, readPersistenceCliRegistration } from '../core/persistence/local-client.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities } from '../core/persistence/ipc.ts';
import { IPC_UNAVAILABLE, readIpcSecretForConfig, resolveSocketPathForConfig,
  requestHermesStart, requestHermesStatus, requestHermesAbort } from '../core/context/resolve-ipc.ts';
import { resolveSourceIdEngineFree } from '../core/source-resolver.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { maintenanceJsonReceipt, type HermesMaintenanceArgs } from '../cli/commands/hermes.ts';

export async function maybeDelegateHermesMaintenance(args: HermesMaintenanceArgs): Promise<boolean> {
  const config = residentPersistenceConfig(loadConfig());
  if (config?.engine !== 'pglite' || !config.database_path || config.database_url) return false;
  const holder = inspectLockHolder(config.database_path);
  if (!holder.held || !holder.serve) return false;
  // Once a live serve is observed, no owner failure falls back to a competing opener.
  const socket = resolveSocketPathForConfig(config);
  const secret = readIpcSecretForConfig(config);
  const persistenceSocket = persistenceSocketPathForConfig(config);
  if (!socket || !secret || !persistenceSocket) throw new Error('The live PGLite owner exposes no authenticated maintenance IPC. Upgrade and restart that serve; its lock remains intact.');
  const capability = await requestPersistenceCapabilities(persistenceSocket);
  const registration = readPersistenceCliRegistration(capability.brain_id);
  const sourceId = resolveSourceIdEngineFree(args.source ?? null);
  const clientToken = randomUUID();
  const options = { stateDb: args.stateDb, enrich: args.enrich, windowSeconds: args.windowSeconds, limit: args.limit,
    ...(sourceId ? { sourceId } : {}), ...(args.brainDir ? { brainDir: args.brainDir } : {}),
    ...(args.sinceIso ? { sinceIso: args.sinceIso } : {}), ...(args.messagesSinceIso ? { messagesSinceIso: args.messagesSinceIso } : {}),
    ...(args.sessionSources.length ? { sessionSources: args.sessionSources } : {}) };
  const request = { secret, clientToken, registration, options };
  let start = await requestHermesStart(socket, request);
  // A lost acknowledgement retries the SAME intent, never a new job token.
  if (start === IPC_UNAVAILABLE) start = await requestHermesStart(socket, request);
  if (start === IPC_UNAVAILABLE || 'degraded' in start) throw new Error('The live serve does not answer Hermes maintenance IPC. Upgrade and restart it; no second database connection was opened.');
  if (!start.ok || !start.jobId) throw new Error(`The live owner refused Hermes maintenance (${start.error ?? 'invalid_response'}). Check its bound source and the existing local CLI writer grant; no grant was widened.`);
  const jobId = start.jobId;
  process.stderr.write(`[hermes] maintenance runs inside live serve PID ${holder.pid ?? 'unknown'} (job ${jobId}).\n`);
  let aborted = false, failures = 0;
  const abort = () => { if (!aborted) { aborted = true; void requestHermesAbort(socket, { secret, jobId }); } };
  process.once('SIGINT', abort);
  const deadline = Date.now() + (args.windowSeconds + 30) * 1000;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        abort();
        throw new Error(`Maintenance job ${jobId} has not settled within its admission window. Abort requested; inspect the live owner before retrying.`);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      const status = await requestHermesStatus(socket, { secret, jobId });
      if (status === IPC_UNAVAILABLE || 'degraded' in status) {
        if (++failures < 20) continue;
        throw new Error(`The live owner stopped answering maintenance job ${jobId}. Its completion state is unknown; inspect it before retrying.`);
      }
      failures = 0;
      if (!status.ok) throw new Error(`Maintenance job ${jobId} is unavailable (${status.error}); the owner may have restarted.`);
      if (status.state === 'error') throw new Error(status.jobError ?? 'The owner could not complete Hermes maintenance');
      if (status.state === 'done' && status.report) {
        const report = status.report;
        if (args.json) await writeStdoutFinal(`${JSON.stringify(maintenanceJsonReceipt(report), null, 2)}\n`);
        else console.log(`Hermes maintenance: ${report.status}; ${report.ingest?.sessionsImported ?? 0} sessions imported, ${report.validation.checked} pages checked; via live owner${report.reasons.length ? `; ${report.reasons.join(', ')}` : ''}`);
        if (report.status !== 'ok') setCliExitVerdict(1);
        return true;
      }
    }
  } finally { process.off('SIGINT', abort); }
}
