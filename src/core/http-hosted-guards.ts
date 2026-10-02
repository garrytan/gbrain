/**
 * Wires the hosted-HTTP fatal exit, pipeline watchdog, and inflight gate
 * onto one server. Route modules read the guards through a WeakMap so
 * serve-http.ts stays a thin registration site.
 */
import { installHostedHttpFatalHandlers } from './http-fatal.ts';
import {
  HttpInflightGate,
  HttpPipelineWatchdog,
  resolveHttpWatchdogConfig,
  type HttpWatchdogConfig,
} from './http-pipeline-watchdog.ts';

export interface HostedHttpGuards {
  config: HttpWatchdogConfig;
  watchdog: HttpPipelineWatchdog;
  gate: HttpInflightGate;
  arm(installFatal: boolean): () => void;
  readyLine(port: number): string;
}

const attached = new WeakMap<object, HostedHttpGuards>();

export function createHostedHttpGuards(
  env: Record<string, string | undefined> = process.env,
  warn?: (msg: string) => void,
): HostedHttpGuards {
  const config = resolveHttpWatchdogConfig(env, warn);
  const watchdog = new HttpPipelineWatchdog(config);
  const gate = new HttpInflightGate(config.maxInflight, config.inflightWaitMs);
  let fatalInstalled = false;
  const guards: HostedHttpGuards = {
    config,
    watchdog,
    gate,
    arm(installFatal: boolean) {
      watchdog.start();
      fatalInstalled = installFatal && config.fatalExit;
      const uninstall = fatalInstalled ? installHostedHttpFatalHandlers() : () => {};
      return () => {
        uninstall();
        watchdog.stop();
      };
    },
    readyLine(port: number) {
      return `[serve-http] Ready: http://localhost:${port}/ready (pipeline=${config.pipelineMs}ms heartbeat=${config.heartbeatMs}ms min_inflight=${config.minInflight}; max_inflight=${config.maxInflight} wait=${config.inflightWaitMs}ms; fatal_exit=${fatalInstalled ? 'on' : 'off'})`;
    },
  };
  return guards;
}

export function attachHostedHttpGuards(ctx: object, guards: HostedHttpGuards): void {
  attached.set(ctx, guards);
}

export function readHostedHttpGuards(ctx: object): HostedHttpGuards | undefined {
  return attached.get(ctx);
}
