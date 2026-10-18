/**
 * #6573: one wording for a local IPC socket path that does not fit the
 * platform's AF_UNIX budget even after the per-user run-dir fallback, shared
 * by the serve's startup log and doctor's `ipc_socket_path` check.
 */
import type { Action } from '../agent-output.ts';
import { localIpcPathTooLong } from './ipc-path.ts';

export interface IpcPathTooLong {
  code: 'ipc_path_too_long';
  path: string;
  bytes: number;
  limit: number;
}

/** The first of `paths` (resolved socket paths) that is still too long, as a typed report. */
export function findIpcPathTooLong(paths: ReadonlyArray<string | null | undefined>): IpcPathTooLong | null {
  for (const path of paths) {
    if (!path) continue;
    const problem = localIpcPathTooLong(path);
    if (problem) return { code: 'ipc_path_too_long', ...problem };
  }
  return null;
}

export function ipcPathTooLongMessage(problem: IpcPathTooLong): string {
  return `ipc_path_too_long: the local IPC socket path ${problem.path} is ${problem.bytes} bytes, over this platform's ${problem.limit}-byte limit, ` +
    'so hooks and local commands cannot reach gbrain serve on this brain. Move the brain to a shorter path, then restart serve.';
}

export function ipcPathTooLongFix(): Action {
  return {
    argv: ['gbrain', 'config', 'set', 'database_path', '<SHORTER_DATA_DIR>'],
    inputs: [{ name: 'SHORTER_DATA_DIR', how: 'Stop gbrain serve, move the PGLite data directory to a path near the drive root (for example C:\\gbrain\\brain.pglite), and pass that new path.' }],
    consent: [],
    actor: 'user',
    why: 'The socket path is derived from the data directory; a shorter data directory gives a socket path the operating system accepts.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'ipc_socket_path', '--json'] },
    docs: 'docs/guides/troubleshooting.md#ipc-path-too-long',
    requires_exclusive: true,
  };
}
