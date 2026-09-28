import type { BrainEngine } from '../core/engine.ts';
import { VERSION } from '../version.ts';
import { assertWorkerDbReadiness } from '../core/minions/db-probe.ts';
import { checkChildReadiness, CHILD_READINESS_PROTOCOL_VERSION } from '../core/minions/child-readiness.ts';
import { childConfigurationError, resolveChildCliInvocation, type ChildCliInvocation } from '../core/minions/job-isolation.ts';
import type { LocalConfigurationError } from '../core/minions/configuration-error.ts';
import { writeWorkerProcessingStatus, type ProcessingRuntimeIdentity, type WorkerProcessingUpdate, type WorkerStartupStage } from '../core/minions/processing-state.ts';

let selectedChildIdentity: ProcessingRuntimeIdentity | undefined;
const currentInvocation = resolveChildCliInvocation({}, process.execPath, process.argv[1], () => null);
const workerIdentity = {
  executable: currentInvocation?.argsPrefix[0] ?? currentInvocation?.cmd ?? process.execPath,
  version: VERSION,
};

export async function checkWorkerStartup(
  engine: BrainEngine,
  invocation: ChildCliInvocation | null,
  tiniPath: string,
): Promise<ProcessingRuntimeIdentity | undefined> {
  selectedChildIdentity = invocation
    ? { executable: invocation.argsPrefix[0] ?? invocation.cmd, version: 'unknown' }
    : undefined;
  reportWorkerStarting('database_readiness');
  await assertWorkerDbReadiness(engine);
  if (!invocation) return undefined;
  reportWorkerStarting('child_readiness');
  const child = await checkChildReadiness({ invocation, tiniPath });
  if (child.versionSkew) {
    console.error(`[gbrain jobs] selected child version ${child.version} differs from worker ${VERSION}; required protocol and capabilities are compatible.`);
  }
  selectedChildIdentity = {
    executable: invocation.argsPrefix[0] ?? invocation.cmd,
    version: child.version,
    protocol_version: CHILD_READINESS_PROTOCOL_VERSION,
  };
  return selectedChildIdentity;
}

function publishRequiredWorkerStatus(update: WorkerProcessingUpdate): void {
  const published = writeWorkerProcessingStatus(update);
  if (!published && (process.env.GBRAIN_WORKER_STATUS_PATH || process.env.GBRAIN_WORKER_STATUS_TOKEN)) {
    const error = new Error('Worker readiness status could not be published; no jobs were admitted. Inspect the owner runtime directory and restart its owner.');
    console.error(`[health] ${error.message}`);
    throw error;
  }
}

export function reportWorkerStarting(stage: WorkerStartupStage): void {
  publishRequiredWorkerStatus({ state: 'starting', stage, worker_identity: workerIdentity, child_identity: selectedChildIdentity });
}

export function reportWorkerReady(childIdentity?: ProcessingRuntimeIdentity): void {
  publishRequiredWorkerStatus({
    state: 'ready',
    worker_identity: workerIdentity,
    child_identity: childIdentity,
  });
}

export function reportWorkerConfiguration(error: LocalConfigurationError): void {
  writeWorkerProcessingStatus({
    state: 'configuration_blocked',
    reason_code: error.reasonCode,
    worker_identity: workerIdentity,
    child_identity: selectedChildIdentity,
  });
  console.error(`[health] configuration blocked (${error.reasonCode}): ${childConfigurationError(error.reasonCode).message}`);
  console.error('[health] No new jobs will run. Repair this installation and explicitly restart its owner. See docs/guides/minions-fix.md.');
}

export function reportInlineWorkerConfiguration(error: LocalConfigurationError): void {
  console.error(`[health] configuration blocked (${error.reasonCode}): ${childConfigurationError(error.reasonCode).message}`);
  console.error('[health] The inline worker admitted no jobs. Repair this installation and rerun. See docs/guides/minions-fix.md.');
}
