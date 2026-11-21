/**
 * The value and error codec of the Rust engine owner IPC (docs/designs/RUST_ENGINE.md, "Owner protocol for the Rust
 * engine"). A client process sends BrainEngine arguments to the owner process and gets the return value or the thrown
 * error back over a JSON socket. The codec keeps what JSON drops: Dates, typed arrays, Buffers, bigints, undefined,
 * NaN and infinities, -0, Maps and Sets, and the class and own properties of an error. A decoded value serializes to
 * the same JSON as the value the owner produced, so the CLI and MCP output of a client is byte-identical to an
 * in-process call.
 *
 * Tagged values are objects with a `$t` key. A plain object that has its own `$t` key is escaped as `{ $t: 'obj' }`,
 * so no caller data is read as a tag. Functions do not cross: `encode` calls `onFunction` for each one (the client
 * turns a void callback into a callback id, the owner refuses the rest).
 */
import { OperationError } from '../../ops/contract.ts';
import { PageMissingError } from '../../engine-errors.ts';
import { guardedBodySite, guardSegmentedBody, type SegmentedBodyField } from '../../page-body/page-shape.ts';
import { PageSourceMissingError } from '../../page-state/guards.ts';
import {
  PageProjectionConflictError, PageRevisionConflictError, PageSnapshotAmbiguousError, RevisionBackfillPendingError,
} from '../../page-state/types.ts';
import { DerivedLinkEndpointChangedError, DerivedLinkRepairRequiredError, DerivedLinkSettingsChangedError } from '../../derived-links.ts';
import { RetryAbortError } from '../../retry.ts';
import { EmbeddingColumnNotRegisteredError } from '../../search/embedding-column.ts';
import { GBrainError } from '../../types.ts';
import { ReadDeadlineError } from '../../read-deadline.ts';
import { StatementDeadlineError } from '../../statement-deadline.ts';

export type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };

export interface EncodeOptions {
  /** Called for each function in the value; returns the wire form or throws. Without it a function throws. */
  onFunction?: (fn: (...args: unknown[]) => unknown, path: string) => Wire;
  /** Called for each AbortSignal; returns the wire form. Without it a signal encodes as undefined. */
  onSignal?: (signal: AbortSignal, path: string) => Wire;
}

export interface DecodeOptions {
  /** Rebuilds a function from its wire form. Without it a function tag throws. */
  onFunction?: (wire: { [key: string]: Wire }) => unknown;
  /** Rebuilds an AbortSignal from its wire form. Without it a signal tag decodes as undefined. */
  onSignal?: (wire: { [key: string]: Wire }) => unknown;
}

/** A value the codec cannot send (a function with no handler, a symbol, a cycle). */
export class OwnerIpcEncodeError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = 'OwnerIpcEncodeError';
  }
}

// Error classes the client rebuilds with their own prototype, so `instanceof` and getters keep working. An error of
// another class is rebuilt on the nearest built-in prototype and keeps its `name`, own properties and JSON.
const BUILT_IN_ERROR_CLASSES: Record<string, ErrorConstructor | (new (...args: never[]) => Error)> = {
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
  OperationError, ReadDeadlineError, StatementDeadlineError,
};

// The domain errors a served member or whole operation throws and a caller recovers from with `instanceof` (add_link
// reclassifies a PageMissingError, revision handling reads PageRevisionConflictError and its subclasses). They are
// listed in a function so a module-load cycle through the engine never reads a class before it exists.
const domainErrorClasses = (): Record<string, new (...args: never[]) => Error> => ({
  PageMissingError, PageRevisionConflictError, RevisionBackfillPendingError, PageProjectionConflictError,
  PageSnapshotAmbiguousError, PageSourceMissingError,
  DerivedLinkEndpointChangedError, DerivedLinkSettingsChangedError, DerivedLinkRepairRequiredError,
  EmbeddingColumnNotRegisteredError, GBrainError, RetryAbortError,
});

let errorClasses: Record<string, ErrorConstructor | (new (...args: never[]) => Error)> | undefined;
const ERROR_CLASSES = (): Record<string, ErrorConstructor | (new (...args: never[]) => Error)> =>
  errorClasses ??= { ...BUILT_IN_ERROR_CLASSES, ...domainErrorClasses() };

/** Registers an error class the owner may throw, so a client rebuilds it with that prototype. */
export function registerOwnerIpcErrorClass(name: string, cls: new (...args: never[]) => Error): void {
  ERROR_CLASSES()[name] = cls;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeNumber(value: number): Wire {
  if (Number.isNaN(value)) return { $t: 'num', v: 'NaN' };
  if (value === Infinity) return { $t: 'num', v: 'Infinity' };
  if (value === -Infinity) return { $t: 'num', v: '-Infinity' };
  if (Object.is(value, -0)) return { $t: 'num', v: '-0' };
  return value;
}

function encodeBytes(tag: 'u8' | 'buf', bytes: Uint8Array): Wire {
  return { $t: tag, v: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') };
}

/** Encodes a thrown value with its class name, message, stack and own properties in their own order. */
export function encodeError(error: unknown, opts: EncodeOptions = {}, path = 'error'): Wire {
  if (!(error instanceof Error)) return { $t: 'throw', v: encodeValue(error, opts, path, new Set()) };
  const props: Wire[] = [];
  for (const key of Reflect.ownKeys(error)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
    if (!('value' in descriptor)) continue; // an accessor is the class's, not the instance's
    let value: Wire;
    try { value = encodeValue(descriptor.value, opts, `${path}.${key}`, new Set()); }
    catch { value = { $t: 'undef' }; } // an unsendable property never hides the error itself
    props.push([key, value, descriptor.enumerable === true]);
  }
  // A platform error (DOMException) keeps its message on a prototype getter; send it as an own property.
  if (!Object.hasOwn(error, 'message') && typeof error.message === 'string') props.push(['message', error.message, false]);
  return { $t: 'err', cls: error.constructor?.name ?? 'Error', name: error.name, props };
}

export function decodeError(wire: Wire, opts: DecodeOptions = {}): unknown {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return wire;
  if (wire.$t === 'throw') return decodeValue(wire.v, opts);
  if (wire.$t !== 'err') return decodeValue(wire, opts);
  const cls = typeof wire.cls === 'string' ? ERROR_CLASSES()[wire.cls] : undefined;
  const name = typeof wire.name === 'string' ? wire.name : 'Error';
  const fallback = ERROR_CLASSES()[name] ?? Error;
  const error = Object.create((cls ?? fallback).prototype) as Error;
  for (const entry of Array.isArray(wire.props) ? wire.props : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
    Object.defineProperty(error, entry[0], {
      value: decodeValue(entry[1] as Wire, opts), enumerable: entry[2] === true, writable: true, configurable: true,
    });
  }
  // A class the client does not know keeps its name, so messages and `error.name` checks read the same.
  if (!cls && !Object.hasOwn(error, 'name') && error.name !== name) {
    Object.defineProperty(error, 'name', { value: name, enumerable: false, writable: true, configurable: true });
  }
  return error;
}

export function encodeValue(value: unknown, opts: EncodeOptions = {}, path = 'value', seen = new Set<object>()): Wire {
  switch (typeof value) {
    case 'undefined': return { $t: 'undef' };
    case 'boolean': case 'string': return value;
    case 'number': return encodeNumber(value);
    case 'bigint': return { $t: 'big', v: value.toString() };
    case 'function': {
      if (!opts.onFunction) throw new OwnerIpcEncodeError(`A function cannot cross the owner socket (${path}).`, path);
      return opts.onFunction(value as (...args: unknown[]) => unknown, path);
    }
    case 'symbol': throw new OwnerIpcEncodeError(`A symbol cannot cross the owner socket (${path}).`, path);
  }
  if (value === null) return null;
  const object = value as object;
  if (object instanceof Date) return { $t: 'date', v: Number.isNaN(object.getTime()) ? null : object.toISOString() };
  if (Buffer.isBuffer(object)) return encodeBytes('buf', object);
  if (object instanceof Uint8Array) return encodeBytes('u8', object);
  if (object instanceof Float32Array) return { $t: 'f32', v: encodeBytes('u8', new Uint8Array(object.buffer, object.byteOffset, object.byteLength)) };
  if (object instanceof Float64Array) return { $t: 'f64', v: encodeBytes('u8', new Uint8Array(object.buffer, object.byteOffset, object.byteLength)) };
  if (typeof AbortSignal !== 'undefined' && object instanceof AbortSignal) return opts.onSignal ? opts.onSignal(object, path) : { $t: 'undef' };
  if (object instanceof Error) return encodeError(object, opts, path);
  if (seen.has(object)) throw new OwnerIpcEncodeError(`A cyclic value cannot cross the owner socket (${path}).`, path);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const out: Wire[] = new Array(object.length);
      for (let i = 0; i < object.length; i++) out[i] = encodeValue(object[i], opts, `${path}[${i}]`, seen);
      return out;
    }
    if (object instanceof Map) {
      const entries: Wire[] = [];
      let i = 0;
      for (const [k, v] of object) { entries.push([encodeValue(k, opts, `${path}.key${i}`, seen), encodeValue(v, opts, `${path}.value${i}`, seen)]); i++; }
      return { $t: 'map', v: entries };
    }
    if (object instanceof Set) {
      const items: Wire[] = [];
      let i = 0;
      for (const item of object) items.push(encodeValue(item, opts, `${path}.item${i++}`, seen));
      return { $t: 'set', v: items };
    }
    // A class instance other than the ones above crosses as its own enumerable data, as JSON.stringify sends it.
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (!isPlainObject(object) && typeof toJSON === 'function') return encodeValue(toJSON.call(object), opts, path, seen);
    const out: { [key: string]: Wire } = {};
    let tagged = false;
    for (const key of Object.keys(object)) {
      if (key === '$t') tagged = true;
      // A segmented page's body fields are getters that throw page_body_segmented: send the guard, never call it.
      const guard = guardedBodySite(Object.getOwnPropertyDescriptor(object, key)?.get);
      if (guard !== undefined) { setOwn(out, key, { $t: 'guard', site: guard }); continue; }
      setOwn(out, key, encodeValue((object as Record<string, unknown>)[key], opts, `${path}.${key}`, seen));
    }
    return tagged ? { $t: 'obj', v: out } : out;
  } finally {
    seen.delete(object);
  }
}

function decodeBytes(wire: Wire): Buffer {
  return Buffer.from(typeof wire === 'string' ? wire : '', 'base64');
}

function decodeNumber(v: Wire): number {
  switch (v) {
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    case '-Infinity': return -Infinity;
    case '-0': return -0;
    default: return Number(v);
  }
}

function decodeTagged(wire: { [key: string]: Wire }, opts: DecodeOptions): unknown {
  switch (wire.$t) {
    case 'undef': return undefined;
    case 'num': return decodeNumber(wire.v);
    case 'big': return BigInt(String(wire.v));
    case 'date': return new Date(wire.v === null ? NaN : String(wire.v));
    case 'buf': return decodeBytes(wire.v);
    case 'u8': { const b = decodeBytes(wire.v); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
    case 'f32': case 'f64': {
      const inner = wire.v as { [key: string]: Wire };
      const b = decodeBytes(inner?.v ?? '');
      const copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return wire.$t === 'f32' ? new Float32Array(copy) : new Float64Array(copy);
    }
    case 'map': return new Map((wire.v as Wire[]).map(entry => {
      const [k, v] = entry as Wire[];
      return [decodeValue(k, opts), decodeValue(v, opts)] as const;
    }));
    case 'set': return new Set((wire.v as Wire[]).map(item => decodeValue(item, opts)));
    case 'obj': return decodePlain(wire.v as { [key: string]: Wire }, opts);
    case 'err': case 'throw': return decodeError(wire, opts);
    case 'fn': {
      if (!opts.onFunction) throw new OwnerIpcEncodeError('A function reached a decoder that takes none.', 'value');
      return opts.onFunction(wire);
    }
    case 'signal': return opts.onSignal ? opts.onSignal(wire) : undefined;
    // A guard is read only as the value of a guarded body field (decodePlain); anywhere else it would turn into a plain
    // object, so a body that must throw page_body_segmented would read as data. A tag this side does not know is never
    // read as data either: the peer speaks another protocol.
    case 'guard': throw new OwnerIpcEncodeError('A segmented-body guard crossed the owner socket outside a guarded body field.', 'value');
    default: throw new OwnerIpcEncodeError(`An unknown value tag crossed the owner socket (${String(wire.$t).slice(0, 32)}).`, 'value');
  }
}

const GUARDED_FIELDS: ReadonlySet<string> = new Set<SegmentedBodyField>(['compiled_truth', 'timeline', 'content']);

function decodePlain(wire: { [key: string]: Wire }, opts: DecodeOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const guards: Array<[SegmentedBodyField, string]> = [];
  for (const key of Object.keys(wire)) {
    const value = wire[key];
    const isGuard = value !== null && typeof value === 'object' && !Array.isArray(value) && value.$t === 'guard'
      && typeof value.site === 'string' && GUARDED_FIELDS.has(key);
    if (isGuard) guards.push([key as SegmentedBodyField, String((value as { site: Wire }).site)]);
    setOwn(out, key, isGuard ? undefined : decodeValue(value, opts));
  }
  // The guarded body fields throw page_body_segmented again, in the place they held (slug and source read at throw time).
  for (const [field, site] of guards) guardSegmentedBody(out, site, [field]);
  return out;
}

/**
 * Sets `key` as an own data property, as JSON.parse does. A plain assignment of `__proto__` would call the inherited
 * setter instead and drop the field, so data that names it would cross the socket changed.
 */
function setOwn(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

export function decodeValue(wire: Wire, opts: DecodeOptions = {}): unknown {
  if (wire === null || typeof wire !== 'object') return wire;
  if (Array.isArray(wire)) return wire.map(item => decodeValue(item, opts));
  return typeof wire.$t === 'string' ? decodeTagged(wire, opts) : decodePlain(wire, opts);
}
