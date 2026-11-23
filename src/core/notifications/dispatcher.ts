/**
 * Delivers the outbox. `drainOnce` claims due rows for every enabled sink this host can deliver (its `ready()` is
 * null), hands each to its sink and records the outcome; it never throws for a delivery. `startNotificationDispatcher`
 * runs it on an interval inside `gbrain serve --http` (default every 10 s) and whenever an event is queued in the same
 * process; `gbrain notify-drain` runs it once. Rows of a sink this host cannot deliver wait instead of burning attempts.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { ConnectorFetch } from '../connectors/client.ts';
import { loadSinks, sinkEnabled } from './config.ts';
import { claimDue, markDelivered, markFailed, markSkipped } from './outbox.ts';
import { createSink } from './registry.ts';
import { setDispatcherKick } from './emit.ts';
import { NonRetryableSinkError, type NotificationSink } from './types.ts';

export interface DrainResult { delivered: number; skipped: number; retrying: number; failed: number; waiting_sinks: Record<string, string> }

export interface DrainOpts {
  config: GBrainConfig;
  log?: (line: string) => void;
  fetchImpl?: ConnectorFetch;
  /** Rows per claim (default 20); a drain keeps claiming until nothing is due. */
  batch?: number;
  /** Upper bound on rows one drain handles (default 500). */
  max?: number;
  /** Test seam: sinks to use instead of the configured ones. */
  sinks?: NotificationSink[];
}

export async function drainOnce(engine: BrainEngine, opts: DrainOpts): Promise<DrainResult> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const result: DrainResult = { delivered: 0, skipped: 0, retrying: 0, failed: 0, waiting_sinks: {} };
  let sinks = opts.sinks;
  if (!sinks) {
    const { sinks: configs, error } = await loadSinks(engine);
    if (error) log(`[notify] notify.sinks is invalid: ${error}`);
    sinks = [];
    for (const config of configs.filter(sinkEnabled)) {
      const built = createSink(config);
      if ('error' in built) { result.waiting_sinks[config.name] = built.error; continue; }
      sinks.push(built.sink);
    }
  }
  const ready = new Map<string, NotificationSink>();
  for (const sink of sinks) {
    const why = sink.ready();
    if (why) result.waiting_sinks[sink.name] = why; else ready.set(sink.name, sink);
  }
  const max = opts.max ?? 500;
  let handled = 0;
  while (handled < max) {
    const rows = await claimDue(engine, [...ready.keys()], Math.min(opts.batch ?? 20, max - handled));
    if (rows.length === 0) break;
    for (const row of rows) {
      handled++;
      const sink = ready.get(row.sink)!;
      try {
        const outcome = await sink.deliver(row, { engine, config: opts.config, log, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
        if (outcome.status === 'delivered') { await markDelivered(engine, row.id, outcome.delivery ?? null); result.delivered++; }
        else { await markSkipped(engine, row.id, outcome.reason); result.skipped++; }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = await markFailed(engine, row, message, !(error instanceof NonRetryableSinkError));
        if (status === 'failed') { result.failed++; log(`[notify] ${row.sink} gave up on ${row.event} ${row.subject} (attempt ${row.attempts}): ${message}`); }
        else { result.retrying++; log(`[notify] ${row.sink} will retry ${row.event} ${row.subject} (attempt ${row.attempts}): ${message}`); }
      }
    }
  }
  return result;
}

export interface NotificationDispatcher { stop(): Promise<void>; kick(): void }

/** Run drainOnce on an interval and on every in-process kick; overlapping runs coalesce into one follow-up run. */
export function startNotificationDispatcher(engine: BrainEngine, opts: DrainOpts & { everyMs?: number }): NotificationDispatcher {
  const log = opts.log ?? ((line: string) => console.error(line));
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let lastWaiting = '';
  const run = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = (async () => {
      try {
        do {
          again = false;
          const result = await drainOnce(engine, { ...opts, log });
          const waiting = JSON.stringify(result.waiting_sinks);
          if (waiting !== lastWaiting && waiting !== '{}') log(`[notify] waiting: ${waiting}`);
          lastWaiting = waiting;
        } while (again && !stopped);
      } catch (error) {
        log(`[notify] dispatcher run failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = null;
      }
    })();
  };
  const timer = setInterval(run, opts.everyMs ?? 10_000);
  (timer as { unref?: () => void }).unref?.();
  setDispatcherKick(run);
  run();
  return {
    kick: run,
    async stop() {
      stopped = true;
      clearInterval(timer);
      setDispatcherKick(null);
      await running;
    },
  };
}
