/**
 * #6573: the brain's local IPC socket paths (resolve and, on PGLite,
 * persistence) fit the platform's AF_UNIX budget. On Windows a long PGLite
 * data-dir path moves to the per-user run dir; only a path still too long
 * there is reported, as `ipc_path_too_long`. Silent when every path fits.
 */
import { loadConfig } from '../../../core/config.ts';
import { resolveSocketPathForConfig } from '../../../core/context/resolve-ipc.ts';
import { findIpcPathTooLong, ipcPathTooLongFix, ipcPathTooLongMessage } from '../../../core/context/ipc-path-too-long.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

async function runIpcSocketPath(_ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  let cfg: ReturnType<typeof loadConfig> = null;
  try { cfg = loadConfig(); } catch { return checks; }
  if (!cfg) return checks;
  let paths: Array<string | null>;
  try { paths = [resolveSocketPathForConfig(cfg), resolveSocketPathForConfig(cfg, 'persistence')]; } catch { return checks; }
  const problem = findIpcPathTooLong(paths);
  if (!problem) return checks;
  checks.push({
    name: 'ipc_socket_path',
    status: 'warn',
    message: ipcPathTooLongMessage(problem),
    details: { ...problem },
    fix: ipcPathTooLongFix(),
  });
  return checks;
}

export const ipcSocketPathEntry: DoctorEntry = {
  name: 'ipc_socket_path',
  emits: ['ipc_socket_path'],
  run: runIpcSocketPath,
};
