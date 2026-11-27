/**
 * The swap run's check of the live brain server (lane L5, B1 run half). The plan accepts a brain with writers on many
 * hosts on this host's configuration only (destination.ts `configDestination`), because no server can serve the shadow
 * store before the cutover. After its switch state the run calls `probeServedDestination` on the address the plan bound
 * (`GBRAIN_RUST_SERVER_LISTEN`) and keeps the Rust brain only on `ok`; any other verdict gives authority back to the old
 * engine. Wiring the probe into the swap run is a separate change; this module only reads.
 *
 * The probe connects through the served client (served/client.ts `connectServed`, protocol v3, TLS verified before the
 * token is sent), then requires, in order:
 *   - a v3 brain server hello (`not_served` otherwise; `refused` when the server refuses the probe's credential);
 *   - `multi_writer` among the hello's capabilities (`not_multi_writer`): the server runs its brain in multi-user mode;
 *   - the server's persistence brain id equal to the brain the plan swaps (`wrong_brain`).
 * A server that does not answer is `unreachable`; a certificate the probe does not trust is `tls_failed`, and then no
 * token was sent. The verdict names the reason and a detail line with no credential in it.
 */
import { connectServed, type ConnectServedOptions, type ServedConnection } from '../rust-engine/served/client.ts';
import { parseListenAddress } from '../rust-engine/served/listener.ts';
import type { SwapDestinationEvidence } from './destination.ts';

export type ServedProbeReason = 'unreachable' | 'tls_failed' | 'not_served' | 'refused' | 'not_multi_writer' | 'wrong_brain';

export type ServedProbeVerdict =
  | { ok: true; url: string; server_id: string; brain_id: string }
  | { ok: false; url: string; reason: ServedProbeReason; detail: string; brain_id?: string | null };

export interface ServedProbeInput {
  /** The `host:port` the plan bound (destination.ts evidence `listen`). */
  listen: string;
  /**
   * The persistence brain id the server must report (`readPersistenceBrainId`): the store brain id the plan bound
   * (`plannedProbeTarget`), never the brain name the plan resolves (`host`).
   */
  expectedBrainId: string;
  /** An owner server token of that brain (served/owner-token.ts). Never printed. */
  token?: string;
  /** PEM CA certificates that sign the server certificate (default: the system store). */
  ca?: string | Buffer;
  /** How long the connection and the identity call may take (default 5 s each). */
  timeoutMs?: number;
  /** Test seam: the client to connect with (default `connectServed`). */
  connect?: (url: string, opts: ConnectServedOptions) => Promise<ServedConnection>;
}

/**
 * What the swap run probes for an approved plan: the address and the store brain id its config evidence bound (both
 * are in the plan hash), or null when the plan bound none (no evidence, a probe, refused config evidence), and then
 * there is no served destination to check.
 */
export function plannedProbeTarget(evidence: SwapDestinationEvidence | null | undefined): Pick<ServedProbeInput, 'listen' | 'expectedBrainId'> | null {
  if (!evidence || evidence.source !== 'config' || !evidence.served || !evidence.listen || !evidence.store_brain_id) return null;
  return { listen: evidence.listen, expectedBrainId: evidence.store_brain_id };
}

/** The served-client URL of a listen address: always TLS, since only a non-loopback TLS listen counts at plan time. */
export function probeUrl(listen: string): string {
  const { host, port } = parseListenAddress(listen);
  return `gbrain+tls://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

interface ErrorLike { code?: unknown; reason?: unknown; detail?: unknown; message?: unknown }

/** Sorts a failed connect into a verdict reason by the served client's typed error (served/errors.ts, routes.ts). */
function connectFailure(error: unknown): { reason: ServedProbeReason; detail: string } {
  const e = (error ?? {}) as ErrorLike;
  const code = String(e.code ?? 'unknown');
  const reason = typeof e.reason === 'string' ? e.reason : '';
  const detail = typeof e.detail === 'string' ? e.detail : '';
  const facts = `code=${code}${reason ? ` reason=${reason}` : ''}${detail ? ` ${detail}` : ''}`;
  if (reason === 'tls_untrusted') return { reason: 'tls_failed', detail: `the server certificate was not trusted, so no token was sent (${facts})` };
  if (code === 'permission_denied') return { reason: 'refused', detail: `the server refused the probe's credential (${facts})` };
  // The transport opened but no v3 brain server hello came back: another service, or an owner that speaks only v2.
  if (reason === 'version_mismatch' || /phase=hello/.test(detail)) return { reason: 'not_served', detail: `the address answered, but not as a brain server (${facts})` };
  return { reason: 'unreachable', detail: `the server did not answer (${facts})` };
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'timeout', detail: `phase=${what} timeout=true` })), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Probes the brain server at `input.listen` once; never throws for a server-side outcome. */
export async function probeServedDestination(input: ServedProbeInput): Promise<ServedProbeVerdict> {
  let url: string;
  try { url = probeUrl(input.listen); } catch {
    return { ok: false, url: input.listen, reason: 'unreachable', detail: `${input.listen} is not host:port` };
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  const connect = input.connect ?? connectServed;
  let connection: ServedConnection;
  try {
    connection = await connect(url, {
      ...(input.token ? { token: input.token } : {}), ...(input.ca ? { ca: input.ca } : {}),
      timeoutMs, reconnectMs: 0,
    });
  } catch (error) {
    return { ok: false, url, ...connectFailure(error) };
  }
  try {
    const hello = connection.hello;
    if (hello?.v !== 3 || typeof hello.server_id !== 'string') {
      return { ok: false, url, reason: 'not_served', detail: 'the server did not answer with a protocol v3 brain server hello' };
    }
    const capabilities = Array.isArray(hello.capabilities) ? hello.capabilities : [];
    if (!capabilities.includes('multi_writer')) {
      return { ok: false, url, reason: 'not_multi_writer', detail: `the brain server ${hello.server_id} does not run its brain in multi-user mode (no multi_writer capability)` };
    }
    let seen: unknown;
    try {
      seen = await withTimeout(connection.request('call', 'readPersistenceBrainId', []), timeoutMs, 'identity');
    } catch (error) {
      const f = connectFailure(error);
      return { ok: false, url, reason: f.reason === 'unreachable' ? 'unreachable' : 'not_served', detail: `the brain server did not report its brain id (${f.detail})` };
    }
    const brainId = typeof seen === 'string' && seen !== '' ? seen : null;
    if (brainId !== input.expectedBrainId) {
      return { ok: false, url, reason: 'wrong_brain', brain_id: brainId,
        detail: brainId
          ? `the brain server serves brain ${brainId}, not ${input.expectedBrainId}, the brain the plan bound: the store changed after the plan, or the server serves another store`
          : 'the brain server has no brain id' };
    }
    return { ok: true, url, server_id: hello.server_id, brain_id: brainId };
  } finally {
    connection.close();
  }
}
