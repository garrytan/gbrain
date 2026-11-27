/**
 * The swap destination, read from the destination itself (never from the engine the brain runs on today).
 *
 * `gbrain engine swap --to rust --plan` refuses `multiple_writer_hosts` unless the multi-user switch is on
 * (`GBRAIN_RUST_MULTIUSER=1`, src/core/rust-engine/multiuser-switch.ts) AND this evidence says the target is a served
 * Rust brain in multi-user mode for the brain being swapped (docs/designs/rust-engine/multi-user-server.md, I-0 and
 * the `served` capability of I-8). Anything missing, embedded, mismatched or switched off keeps refusing.
 *
 * The production command reads the evidence from this host's configuration only (`configDestination`): the swap's
 * destination is the shadow store, which only the shadow owner opens until the cutover, so no server can serve it
 * while the plan runs. The plan says its check is config-only; the swap run checks the live server after its switch
 * state and restores authority to the old engine when the server does not answer as a served multi-user Rust brain.
 * Tests may inject a probe instead (`resolveSwapDestination`).
 */
import { rustMultiuserFromEnv } from '../rust-engine/multiuser-switch.ts';
import { isLoopbackHost, parseListenAddress, RUST_SERVER_LISTEN_ENV, RUST_SERVER_TLS_CERT_ENV, RUST_SERVER_TLS_KEY_ENV } from '../rust-engine/served/listener.ts';

export interface SwapDestinationEvidence {
  /** The destination's engine kind. Only `rust` can ever qualify. */
  engine: string;
  /** The brain the destination serves, when it says; null is "unknown", which never qualifies. */
  brain_id: string | null;
  /** The destination reports the `served` capability: it is a client of a server, not an embedded store. */
  served: boolean;
  /** The destination runs multi-user mode. */
  multiuser: boolean;
  /**
   * `probe`: read from the destination. `config`: read from this host's configuration only (no server was reached).
   * `none`: nothing was read, so nothing counts.
   */
  source: 'probe' | 'config' | 'none';
  /** Config evidence: the address this host's brain server listens on (`GBRAIN_RUST_SERVER_LISTEN`), when valid. */
  listen?: string;
  /** Config evidence that does not count: why, in words the plan prints. */
  refused?: string;
}

/** What a destination probe reports (the facts only; the resolver adds the source). */
export type SwapDestinationProbe = (brainId: string) => Promise<Pick<SwapDestinationEvidence, 'engine' | 'brain_id' | 'served' | 'multiuser'> | null>;

/** The evidence of a destination nobody probed. */
export const NO_DESTINATION: SwapDestinationEvidence = { engine: 'rust', brain_id: null, served: false, multiuser: false, source: 'none' };

/**
 * Resolves the destination for `brainId`. The default has no probe (the server lands in lane L3), so it reports no
 * evidence and the plan refuses exactly as before. A probe that throws or answers null is also no evidence.
 */
export async function resolveSwapDestination(brainId: string, probe?: SwapDestinationProbe): Promise<SwapDestinationEvidence> {
  if (!probe) return { ...NO_DESTINATION };
  let seen: Awaited<ReturnType<SwapDestinationProbe>>;
  try { seen = await probe(brainId); } catch { return { ...NO_DESTINATION }; }
  if (!seen) return { ...NO_DESTINATION };
  return { engine: seen.engine, brain_id: seen.brain_id, served: seen.served === true, multiuser: seen.multiuser === true, source: 'probe' };
}

export interface DestinationOptions {
  /** The destination evidence; absent or `source: 'none'` counts as no evidence. */
  destination?: SwapDestinationEvidence | null;
  /** The brain being swapped; the destination must serve this one. Missing refuses. */
  expectedBrainId?: string;
  /** The resolved switch; default: the environment's `GBRAIN_RUST_MULTIUSER`. Off forces every destination to "no". */
  multiuser?: boolean;
}

/** The evidence that counts: present, read from a probe, and only while the switch is on. */
export function usableDestination(opts: DestinationOptions | undefined): SwapDestinationEvidence | null {
  const d = opts?.destination;
  if (!d || (d.source !== 'probe' && d.source !== 'config')) return null;
  if (!(opts.multiuser ?? rustMultiuserFromEnv())) return null;
  return d;
}

/** True only for a served multi-user Rust destination that serves the brain being swapped, with the switch on. */
export function destinationAllowsManyWriters(opts: DestinationOptions | undefined): boolean {
  const d = usableDestination(opts);
  if (!d) return false;
  return d.engine === 'rust' && d.served === true && d.multiuser === true
    && d.brain_id !== null && opts!.expectedBrainId !== undefined && d.brain_id === opts!.expectedBrainId;
}

/** What this host's configuration says about serving the brain it swaps (`configDestination`'s inputs). */
export interface ConfigDestinationInputs {
  /** The environment the command runs with: the switch, the listen address and the TLS files are read from it. */
  env: Readonly<Record<string, string | undefined>>;
  /** `rust_server.url` from this host's gbrain config, when set. */
  rustServerUrl?: string | null;
}

/**
 * The destination as this host's configuration describes it, never a server reached (no server can serve the shadow
 * store before the cutover). It counts as a served multi-user Rust brain for `brainId` only when all of these hold:
 *   - the switch is on (`GBRAIN_RUST_MULTIUSER=1`): a brain server runs only with it (serve-listen.ts);
 *   - this host will serve the brain: `GBRAIN_RUST_SERVER_LISTEN` is a valid host:port, the setting `gbrain serve`
 *     listens on (serve.ts, listener.ts);
 *   - the other writer hosts can reach it: not a loopback address, and both TLS files are named, which the listener
 *     needs on any other address (the files are read only when the server starts, never here);
 *   - this host is not itself a client: its config names no `rust_server.url` and `GBRAIN_RUST_SERVER_URL` is unset.
 *     With either set, a Rust engine on this host connects to that server instead of opening the store
 *     (engine-construct.ts), so a brain server started here could not serve the swapped brain.
 * Otherwise the evidence is `served: false` with the reason in `refused`, and the plan keeps refusing.
 */
export function configDestination(brainId: string, inputs: ConfigDestinationInputs): SwapDestinationEvidence {
  const { env } = inputs;
  const base: SwapDestinationEvidence = { engine: 'rust', brain_id: brainId, served: false, multiuser: rustMultiuserFromEnv(env), source: 'config' };
  const refuse = (refused: string, listen?: string): SwapDestinationEvidence => ({ ...base, ...(listen ? { listen } : {}), refused });
  if (!base.multiuser) return refuse('GBRAIN_RUST_MULTIUSER is not 1, so no brain server can run');
  // A client host first: with a server named, a Rust engine here connects to it instead of opening the store.
  // engine-construct.ts reads GBRAIN_RUST_SERVER_URL (served/engine.ts RUST_SERVER_URL_ENV) before rust_server.url.
  // cwd-dotenv-ok: read only to refuse; a value from any .env can only keep the refusal, never lift it.
  if (env.GBRAIN_RUST_SERVER_URL) return refuse('GBRAIN_RUST_SERVER_URL is set, so a Rust engine here is a client of that server and cannot serve the swapped brain; unset it on the host that serves');
  if (inputs.rustServerUrl) return refuse('this host\'s config names rust_server.url, so a Rust engine here is a client of that server and cannot serve the swapped brain; remove it on the host that serves');
  const value = env[RUST_SERVER_LISTEN_ENV]?.trim();
  // A server given its address only on the `gbrain serve` command line is invisible to the plan: only the setting counts.
  if (!value) return refuse(`${RUST_SERVER_LISTEN_ENV} is not set; set ${RUST_SERVER_LISTEN_ENV} to the address you serve on (the plan cannot see an address given only on the serve command line)`);
  let at: { host: string; port: number };
  try { at = parseListenAddress(value); } catch { return refuse(`${RUST_SERVER_LISTEN_ENV} is not host:port; set ${RUST_SERVER_LISTEN_ENV} to the address you serve on`); }
  const listen = value;
  if (isLoopbackHost(at.host)) return refuse(`${RUST_SERVER_LISTEN_ENV} ${listen} is a loopback address, which the other writer hosts cannot reach`, listen);
  const cert = env[RUST_SERVER_TLS_CERT_ENV];
  const key = env[RUST_SERVER_TLS_KEY_ENV];
  if (!cert || !key) {
    return refuse(`${RUST_SERVER_LISTEN_ENV} ${listen} is not a loopback address, so the server needs ${RUST_SERVER_TLS_CERT_ENV} and ${RUST_SERVER_TLS_KEY_ENV}`, listen);
  }
  return { ...base, served: true, listen };
}

/**
 * The words criterion 11 adds about the destination, or null when it adds none (a probe, no evidence, the switch off):
 * config evidence says that the plan checked the configuration only, and why it does not count when it does not.
 */
export function destinationNote(opts: DestinationOptions | undefined): string | null {
  const d = usableDestination(opts);
  if (!d || d.source !== 'config') return null;
  if (destinationAllowsManyWriters(opts)) {
    return `accepted on config only: this host is set to serve this brain as a multi-user Rust brain on ${d.listen}; the plan reached no server, `
      + 'and the swap run checks the live server after its switch and restores the old engine when it does not answer as one';
  }
  return `not accepted (config only): ${d.refused ?? 'the configuration does not describe a served multi-user Rust brain for this brain'}`;
}
