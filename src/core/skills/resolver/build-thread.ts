/**
 * `buildSkillIndexOffThread(input, opts)`: buildSkillIndex in a
 * node:worker_threads Worker, so a Node or Bun host's event loop keeps
 * running through a 100+ ms build. It resolves with the same BuildReceipt;
 * a ResolverError thrown in the worker is rethrown here with the same code,
 * message, fix and context.
 *
 * No separate worker file ships: the worker's entry is this module's own
 * URL (in the Node bundle gbrain-skill-resolver.mjs, the bundle itself), and
 * the guard at the bottom runs the build only in a worker started with
 * BUILD_THREAD_MARKER in its workerData. The hook lane's worker never loads
 * this module.
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildSkillIndex, type BuildInput, type BuildReceipt } from './build.ts';
import { ResolverError, type ResolverErrorCode, type ResolverFix } from './errors.ts';
import { resolverHome } from './paths.ts';

export const BUILD_THREAD_MARKER = 'gbrain-skill-resolver-build-thread-v1';

interface Job { [BUILD_THREAD_MARKER]: true; input: BuildInput; home: string }
type Failure = { resolver: true; code: ResolverErrorCode; message: string; fix: ResolverFix; context: Record<string, string | number | boolean> } | { resolver: false; name: string; message: string; code?: string };
type Reply = { receipt: BuildReceipt } | { failure: Failure };

function revive(f: Failure): Error {
  if (f.resolver) return new ResolverError(f.code, f.message, f.fix, f.context);
  return Object.assign(new Error(f.message), { name: f.name, ...(f.code ? { code: f.code } : {}) });
}

/** Build a catalog's index on a worker thread; same input, receipt and errors as buildSkillIndex. */
export function buildSkillIndexOffThread(input: BuildInput, opts: { home?: string } = {}): Promise<BuildReceipt> {
  const home = opts.home ?? resolverHome();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const job: Job = { [BUILD_THREAD_MARKER]: true, input, home };
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.once('message', (m: Reply) => settle(() => ('receipt' in m ? resolve(m.receipt) : reject(revive(m.failure)))));
    worker.once('error', e => settle(() => reject(e)));
    worker.once('exit', () => settle(() => reject(new ResolverError('skill_resolver_internal', 'The skill index build thread exited without a result.', { suggestion: 'Run the build again; if it repeats, run gbrain skills index build in a shell to see the error.' }))));
  });
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[BUILD_THREAD_MARKER] === true) {
  const { input, home } = workerData as Job;
  buildSkillIndex(input, { home }).then(
    receipt => parentPort!.postMessage({ receipt } satisfies Reply),
    (e: unknown) => {
      const failure: Failure = e instanceof ResolverError ? { resolver: true, code: e.code, message: e.message, fix: e.fix, context: e.context }
        : { resolver: false, name: (e as Error)?.name ?? 'Error', message: String((e as Error)?.message ?? e), ...(typeof (e as NodeJS.ErrnoException)?.code === 'string' ? { code: (e as NodeJS.ErrnoException).code } : {}) };
      parentPort!.postMessage({ failure } satisfies Reply);
    },
  );
}
