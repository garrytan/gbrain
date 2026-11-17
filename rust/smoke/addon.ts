/**
 * Loads the Rust engine addon for the smoke tests. The path comes only from
 * GBRAIN_RUST_ENGINE_ADDON (printed by `bun run rust:build`); nothing is searched for.
 *
 * It uses process.dlopen with a path computed at run time. A literal `require('x.node')` would be
 * bundled by `bun build --compile`; a computed path is not, which is what the compiled-binary
 * check in selfcheck.ts depends on.
 */

export interface ShutdownReport {
  cancelledQueued: number;
  finishedRunning: number;
  abandonedRunning: number;
}

export interface CancelToken {
  cancel(): void;
  readonly cancelled: boolean;
}

export interface Pool {
  readonly state: string;
  readonly queued: number;
  readonly running: number;
  readonly workers: number;
  blockFor(ms: number): Promise<number>;
  runSteps(steps: number, stepMs: number, token?: CancelToken): Promise<number>;
  sumF32(values: Float32Array): Promise<number>;
  scaleF32(values: Float32Array, factor: number): Promise<Float32Array>;
  probePanic(): Promise<number>;
  shutdown(waitMs: number): Promise<ShutdownReport>;
}

export interface Sink {
  emit(value: number): string;
  emitFromThread(count: number): Promise<string[]>;
  close(): void;
}

export interface Addon {
  target: string;
  engineAbi: number;
  engineBuild: string;
  catalogVersion: number;
  formatVersions: unknown[];
  sinkMaxQueueSize: number;
  sumF32(values: Float32Array): number;
  scaleF32(values: Float32Array, factor: number): Float32Array;
  scaleInPlaceF32(values: Float32Array, factor: number): number;
  probePanicSync(): void;
  liveWorkers(): number;
  CancelToken: new () => CancelToken;
  Pool: new (workers: number) => Pool;
  Sink: new (callback: (value: number) => void) => Sink;
}

export function loadAddon(path: string | undefined = process.env.GBRAIN_RUST_ENGINE_ADDON): Addon {
  if (!path) {
    throw new Error(
      'GBRAIN_RUST_ENGINE_ADDON is not set. Run `bun run rust:build` and export the path it prints.',
    );
  }
  const module = { exports: {} as unknown };
  process.dlopen(module as NodeJS.Module, path);
  return module.exports as Addon;
}
