/**
 * Multi-user lane L4, groundwork K (design note docs/designs/rust-engine/multi-user-server.md, audit row B2): the owner
 * applies the remote-caller rule itself instead of trusting the client to.
 *
 * Today a remote caller's write is refused only in the client process (client.ts `request`, whole-op.ts
 * `refuseUntrustedCaller`); the owner runs whatever arrives with the owner's own authority. In multi-user mode (I-0;
 * no separate switch), the client marks each frame it sends for a remote caller with `remote: true` (wire protocol v3 field, I-7; an older owner ignores it), and the owner refuses, before
 * it decodes any argument, a `call` frame marked remote whose member is not in OWNER_IPC_REMOTE_READS and every `fn`
 * (whole operation) frame marked remote. When the server knows the caller from an authenticated principal (the v3
 * hello, lane L3), it passes that principal's remote flag: the owner applies the principal's flag, and a frame whose
 * own mark says local while the principal is remote is refused as a mismatch. With multi-user mode off nothing changes.
 *
 * The owner reads the mode from the store it serves (I-0.v2: the environment switch or the brain's config row) and, in
 * multi-user mode, lists OWNER_REMOTE_CHECK_CAP in its hello `capabilities` (audit row B3). A client holds no store of
 * the brain, so it marks frames when the owner's hello lists the check, or by its own environment switch (an owner
 * from before the hello listed it); an owner not in multi-user mode ignores the mark. The mark is a hello-only
 * capability: a client never copies it into its own engine's capabilities (ownerEngineCapabilities).
 */
import { storeMultiuser } from '../access-self-check.ts';
import { rustMultiuserFromEnv } from '../multiuser-switch.ts';
import { OWNER_IPC_REMOTE_READS, ownerIpcRefusal } from './routes.ts';
import { remoteWholeOperationCall } from '../served/remote-whole-ops.ts';

/** The store the owner serves, when its engine has one open (a Rust engine), else none. */
function servedStore(engine: object): object | null {
  const open = (engine as { openStoreIfOpen?: (member: string) => object | null }).openStoreIfOpen;
  return typeof open === 'function' ? open.call(engine, 'ownerRemoteCheck') : null;
}

/** The owner-side check is on for `engine` whenever its store runs in multi-user mode (an owner with no store: the environment switch). */
export function ownerRemoteCheckOn(engine: object): boolean {
  const store = servedStore(engine);
  return store ? storeMultiuser(store) : rustMultiuserFromEnv();
}

/** The hello capability an owner in multi-user mode lists: it applies the remote check to marked frames. */
export const OWNER_REMOTE_CHECK_CAP = 'remote_check';

/** The capabilities an owner's hello lists: its engine's, plus the remote check when it applies one. */
export function ownerHelloCapabilities(engine: object, engineCapabilities: readonly string[]): string[] {
  return ownerRemoteCheckOn(engine) ? [...engineCapabilities, OWNER_REMOTE_CHECK_CAP] : [...engineCapabilities];
}

/** An owner hello's capabilities without the hello-only remote check: what a client's engine reports as its own. */
export function ownerEngineCapabilities(helloCapabilities: readonly string[]): string[] {
  return helloCapabilities.filter(c => c !== OWNER_REMOTE_CHECK_CAP);
}

/**
 * The `remote` mark a client adds to a frame when the owner applies the check (its hello lists it, or the client's
 * own environment switch is on); none otherwise, so a v2 frame is byte-identical.
 */
export function remoteFrameMark(remote: boolean, ownerCapabilities: readonly string[] = []): { remote?: true } {
  return remote && (ownerCapabilities.includes(OWNER_REMOTE_CHECK_CAP) || rustMultiuserFromEnv()) ? { remote: true } : {};
}

/**
 * The refusal for frame `frame` (member `member`) on the owner of `engine` when the owner must not run it for a remote caller, else null.
 * `principalRemote` is the authenticated principal's remote flag when the connection has one.
 */
export function ownerRemoteRefusal(engine: object, frame: Record<string, unknown>, member: string, principalRemote?: boolean, servedWire = false): Error | null {
  if (!ownerRemoteCheckOn(engine)) return null;
  const marked = frame.remote === true;
  if (principalRemote === true && !marked) {
    return ownerIpcRefusal(member, 'the frame says the caller is local, but its connection is a remote caller\'s');
  }
  const remote = principalRemote ?? marked;
  if (!remote) return null;
  // Over the served wire only, a whole operation of the closed list runs (served/remote-whole-ops.ts); never on the socket.
  if (frame.t === 'fn') return servedWire && remoteWholeOperationCall('fn', member, frame.args) ? null
    : ownerIpcRefusal(member, 'a remote caller\'s whole operation is not run by the brain owner');
  if (!OWNER_IPC_REMOTE_READS.has(member)) return ownerIpcRefusal(member, 'a remote caller\'s write is not run by the brain owner');
  return null;
}
