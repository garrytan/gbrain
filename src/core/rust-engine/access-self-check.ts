/**
 * Multi-user lane L4, self-check mode (design note docs/designs/rust-engine/multi-user-server.md, groundwork H/G8).
 *
 * The store members render a caller's privacy policy in TypeScript (store-members/private-provenance.ts and its
 * neighbours) and send the store the flag bag. A multi-user server must not trust a policy a client rendered, so the
 * store also derives it itself from the raw caller record (rust/crates/gbrain-store/src/access_derive.rs). With
 * `GBRAIN_RUST_MULTIUSER=1` and `GBRAIN_RUST_ACCESS_SELF_CHECK=1`, every policy helper runs both and compares them
 * field by field, refusals and absences included; any difference refuses with `access_self_check_mismatch` before
 * the store is called, so a divergence never reaches a read. With either switch off, `selfChecked` only runs the
 * helper.
 *
 * The switch is the brain's own resolved answer (interface I-0.v2, multiuser-switch.ts): the Rust engine runs each
 * served member inside `withAccessStore`, which carries that store's multi-user answer and the addon's pure
 * `deriveAccessPolicy` export for the call, so two brains in one process never share a mode. A store that is not in
 * multi-user mode runs its members exactly as before (no context at all). A self-check with no derivation in its
 * context refuses (fail closed).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError, type OperationError } from '../ops/contract.ts';
import { accessSettingsSnapshot, callerAccessRecord } from '../search/private-visibility.ts';
import { rustMultiuserFromEnv, rustMultiuserSubSwitch } from './multiuser-switch.ts';
import { capabilityMissing } from './errors.ts';
import { memberCapability } from './store-members/common.ts';

/** What a helper asks the store to derive (`DeriveRequest` in access_derive.rs). */
export type AccessDeriveRequest =
  | { mode: 'page_text'; fragment: 'caller' | 'floor' | 'plain'; callerReaders?: boolean; noReaders?: boolean; renderedIn?: { record: unknown } }
  | { mode: 'fact'; excludePrivate: boolean; fragment: 'under_policy' | 'for_caller' | 'for_reader'; callerReaders?: boolean }
  | { mode: 'floor_policy' }
  | { mode: 'member_read'; owner: boolean; identity: string[]; satisfied: string[] }
  | { mode: 'member_access' }
  | { mode: 'remote_floor' }
  | { mode: 'visibility'; list?: string[] }
  | { mode: 'privacy_part_aliases' };

type Deriver = (ctx: unknown) => unknown;
/** The store a served member runs on, as the self-check reads it: its multi-user answer and the addon's derivation. */
interface AccessStore { readonly multiuser: boolean; readonly derive?: Deriver; readonly server?: boolean }
const accessStore = new AsyncLocalStorage<AccessStore>();

/**
 * The multi-user answer of a store: its own (`RustStore.multiuser`, the environment switch or the brain's config row),
 * or, from a store that does not report one yet, the environment switch.
 */
export function storeMultiuser(store: object): boolean {
  const own = (store as { multiuser?: unknown }).multiuser;
  return typeof own === 'boolean' ? own : rustMultiuserFromEnv();
}

/**
 * Runs `fn`, a served member on `store`, with the store's answer in context when the store is in multi-user mode;
 * otherwise just runs it. `addon` holds the pure `deriveAccessPolicy` export the self-check compares with.
 */
export function withAccessStore<T>(store: object, addon: object, fn: () => T, opts: { server?: boolean } = {}): T {
  if (!storeMultiuser(store)) return fn();
  const outer = accessStore.getStore();
  const own = (addon as { deriveAccessPolicy?: unknown }).deriveAccessPolicy;
  // Inside a principal session the session's derivation holds (the same addon in production).
  const derive = outer?.server === true && outer.derive ? outer.derive : typeof own === 'function' ? own as Deriver : outer?.derive;
  // Server mode, once set by a principal session (principal-session.ts), holds for every member call inside it.
  const server = opts.server === true || outer?.server === true;
  return accessStore.run({ multiuser: true, ...(derive ? { derive } : {}), ...(server ? { server } : {}) }, fn);
}

/** Server mode: a principal session's call, whose every privacy policy is the store's derivation alone. */
export function accessServerModeOn(): boolean {
  return accessStore.getStore()?.server === true;
}

/** A policy helper must ask the store: the self-check compares, or server mode uses the store's answer alone. */
export function accessDerivationOn(): boolean {
  return accessServerModeOn() || accessSelfCheckOn();
}

/** Comparisons the self-check made in this process, and how many it refused (the CI self-check lane reads them). */
let compared = 0;
let refused = 0;

/** The self-check's counts in this process: comparisons made and refusals raised. */
export function accessSelfCheckStats(): { compared: number; refused: number } {
  return { compared, refused };
}

/** The self-check is on: the store runs in multi-user mode and the access sub-switch is set. */
export function accessSelfCheckOn(): boolean {
  const store = accessStore.getStore();
  return store !== undefined && rustMultiuserSubSwitch('GBRAIN_RUST_ACCESS_SELF_CHECK', store);
}

/** The context the store derives from: the record as it stands (none outside one), the settings and the request. */
export function accessDeriveContext(request: AccessDeriveRequest): unknown {
  const record = callerAccessRecord();
  return { record: record ? JSON.parse(JSON.stringify(record)) : null, settings: accessSettingsSnapshot(), request };
}

/** A helper refusal (`refuseMember`): the policy is not one the store models. */
function isHelperRefusal(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'engine_capability_missing';
}

/** The comparable JSON of a helper outcome: its value, `{$none}` for undefined, `{$refuse}` for a refusal. */
function outcomeJson(value: unknown, refused: boolean): unknown {
  if (refused) return { $refuse: true };
  if (value === undefined) return { $none: true };
  return JSON.parse(JSON.stringify(value));
}

/** The store's answer with the refusal's prose dropped (only the refusal itself is compared). */
function storeJson(value: unknown): unknown {
  if (value && typeof value === 'object' && (value as { $refuse?: unknown }).$refuse === true) return { $refuse: true };
  return value;
}

/**
 * Server mode: the store's derivation is the policy. A refusal raises the same `engine_capability_missing` refusal the
 * TypeScript helper raises; no derivation in context, or one the store cannot read, refuses (fail closed).
 */
function storeDerived<T>(member: string, request: AccessDeriveRequest): T {
  const derive = accessStore.getStore()?.derive;
  if (!derive) throw accessSelfCheckMismatch(member, request.mode, '$derive (no store derivation is in context)');
  const got = derive(accessDeriveContext(request)) as Record<string, unknown> | null;
  if (got && typeof got === 'object' && !Array.isArray(got)) {
    if (got.$invalid !== undefined) throw accessSelfCheckMismatch(member, request.mode, '$invalid');
    if (got.$refuse === true) throw capabilityMissing(memberCapability(member), `${member} (${String(got.why ?? 'a policy the store does not model')})`);
    if (got.$none === true) return undefined as T;
  }
  return got as T;
}

/** The first path where `a` and `b` differ, or null when they are equal (key order ignored). */
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (a === b) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path;
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return path;
}

/** The refusal a self-check difference raises: nothing was read. */
export function accessSelfCheckMismatch(member: string, mode: string, at: string): OperationError {
  return opError('access_self_check_mismatch',
    `${member} was refused before it read anything: the store's own privacy policy for this caller differs from the one TypeScript rendered (${mode}, first difference at ${at}).`,
    'Turn off GBRAIN_RUST_ACCESS_SELF_CHECK to read as before, and report the member, mode and field so the store derivation can be fixed.',
    { reason: mode, detail: `member=${member} mode=${mode} at=${at} written=nothing` });
}

/**
 * Runs the policy helper `run` for `member`; under the self-check, compares its outcome with the store's derivation
 * of `request` in the same context and refuses on any difference. The helper's own value or refusal is returned or
 * rethrown unchanged when they agree.
 */
export function selfChecked<T>(member: string, request: AccessDeriveRequest, run: () => T): T {
  if (accessServerModeOn() && !accessSelfCheckOn()) return storeDerived<T>(member, request);
  if (!accessSelfCheckOn()) return run();
  let value: T | undefined;
  let refusal: unknown;
  let helperRefused = false;
  try {
    value = run();
  } catch (error) {
    if (!isHelperRefusal(error)) throw error;
    refusal = error;
    helperRefused = true;
  }
  const derive = accessStore.getStore()?.derive;
  const got = derive ? storeJson(derive(accessDeriveContext(request))) : { $invalid: 'no store derivation is in context' };
  const at = firstDifference(outcomeJson(value, helperRefused), got);
  compared++;
  if (at !== null) { refused++; throw accessSelfCheckMismatch(member, request.mode, at); }
  if (helperRefused) throw refusal;
  return value as T;
}
