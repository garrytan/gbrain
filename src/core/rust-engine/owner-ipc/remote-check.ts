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
 * The owner reads the mode from the store it serves (I-0.v2: the environment switch or the brain's config row); a
 * client holds no store of the brain, so it marks frames by the environment switch, and an owner not in multi-user
 * mode ignores the mark.
 */
import { storeMultiuser } from '../access-self-check.ts';
import { rustMultiuserFromEnv } from '../multiuser-switch.ts';
import { OWNER_IPC_REMOTE_READS, ownerIpcRefusal } from './routes.ts';

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

/** The `remote` mark a client adds to a frame in multi-user mode (none otherwise, so a v2 frame is byte-identical). */
export function remoteFrameMark(remote: boolean): { remote?: true } {
  return remote && rustMultiuserFromEnv() ? { remote: true } : {};
}

/**
 * The refusal for frame `frame` (member `member`) on the owner of `engine` when the owner must not run it for a remote caller, else null.
 * `principalRemote` is the authenticated principal's remote flag when the connection has one.
 */
export function ownerRemoteRefusal(engine: object, frame: Record<string, unknown>, member: string, principalRemote?: boolean): Error | null {
  if (!ownerRemoteCheckOn(engine)) return null;
  const marked = frame.remote === true;
  if (principalRemote === true && !marked) {
    return ownerIpcRefusal(member, 'the frame says the caller is local, but its connection is a remote caller\'s');
  }
  const remote = principalRemote ?? marked;
  if (!remote) return null;
  if (frame.t === 'fn') return ownerIpcRefusal(member, 'a remote caller\'s whole operation is not run by the brain owner');
  if (!OWNER_IPC_REMOTE_READS.has(member)) return ownerIpcRefusal(member, 'a remote caller\'s write is not run by the brain owner');
  return null;
}
