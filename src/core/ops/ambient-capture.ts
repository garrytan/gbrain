import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { captureGateDecision, resolveWritebackConfig } from '../facts/writeback-config.ts';
import { opError } from './contract.ts';
import { readFix } from './op-fix.ts';

/** Explicit capture is unchanged; automatic transcript writes require this brain's DB opt-in. */
export async function assertAmbientTranscriptCapture(engine: BrainEngine, ambient: unknown, admission = false): Promise<void> {
  if (ambient === undefined || ambient === false) return;
  if (ambient !== true) throw opError('invalid_params', 'capture ambient must be a boolean.',
    'Pass ambient: true only for automatic capture; omit it for an explicit user-requested capture.');
  // Keep an enabled row stable through admission: config set/unset cannot commit
  // an off switch between this check and the journal INSERT. Unset never enables.
  if (admission) await engine.executeRaw('SELECT value FROM config WHERE key=$1 FOR SHARE', ['memory.auto_writeback']);
  const decision = captureGateDecision(await resolveWritebackConfig(engine, loadConfig(), { gate: true }), 'writeback');
  if (decision.action === 'extract') return;
  throw opError('ambient_capture_off', 'Ambient transcript capture is not enabled for this brain; the transcript was not saved.',
    `memory.auto_writeback does not allow automatic transcript capture (${decision.reason}). The brain's authoritative setting must be salient or all; explicit user-requested capture remains available.`,
    { reason: decision.reason, fix: readFix('Shows this brain\'s automatic writeback setting, read-only.',
      { argv: ['gbrain', 'config', 'get', 'memory.auto_writeback'] }) });
}
