/**
 * The wire and comparison encoding of mirrored reads (plan PR S1).
 *
 * `encodeValue` turns call arguments and results into plain JSON that survives the pipe to the shadow child:
 * typed arrays become `{ "$typed": "Float32Array", "v": [...] }`, Dates `{ "$date": iso }`, bigints
 * `{ "$bigint": "123" }`. AbortSignals, functions and symbols are dropped (a mirrored call never shares the caller's
 * cancellation). `decodeValue` reverses it in the child so a vector search gets a real Float32Array back.
 *
 * `canonicalJson` is the comparison form: the encoded value with object keys sorted, so two engines that build the
 * same row in a different key order still match.
 */

const TYPED_ARRAYS = {
  Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;

function isAbortSignal(value: object): boolean {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/** Plain-JSON form of a value; never throws on cycles (a repeated object becomes `{ "$cycle": true }`). */
export function encodeValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'string': case 'boolean': return value;
    case 'number': return Number.isFinite(value) ? value : { $number: String(value) };
    case 'bigint': return { $bigint: value.toString() };
    case 'function': case 'symbol': return undefined;
  }
  const obj = value as object;
  if (obj instanceof Date) return { $date: Number.isNaN(obj.getTime()) ? 'invalid' : obj.toISOString() };
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    const name = obj.constructor.name as TypedArrayName;
    if (name in TYPED_ARRAYS) return { $typed: name, v: Array.from(obj as unknown as ArrayLike<number>) };
    return undefined;
  }
  if (isAbortSignal(obj)) return undefined;
  if (seen.has(obj)) return { $cycle: true };
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item) => { const e = encodeValue(item, seen); return e === undefined ? null : e; });
    if (obj instanceof Map) return { $map: [...obj.entries()].map(([k, v]) => [encodeValue(k, seen), encodeValue(v, seen)]) };
    if (obj instanceof Set) return { $set: [...obj].map((v) => encodeValue(v, seen)) };
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (key === 'signal') continue;
      const e = encodeValue(item, seen);
      if (e !== undefined) out[key] = e;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Reverses `encodeValue`. */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const rec = value as Record<string, unknown>;
  if (typeof rec.$typed === 'string' && Array.isArray(rec.v) && rec.$typed in TYPED_ARRAYS) {
    return new TYPED_ARRAYS[rec.$typed as TypedArrayName](rec.v as number[]);
  }
  if (typeof rec.$date === 'string') return new Date(rec.$date);
  if (typeof rec.$bigint === 'string') return BigInt(rec.$bigint);
  if (typeof rec.$number === 'string') return Number(rec.$number);
  if (Array.isArray(rec.$map)) return new Map((rec.$map as unknown[][]).map(([k, v]) => [decodeValue(k), decodeValue(v)]));
  if (Array.isArray(rec.$set)) return new Set((rec.$set as unknown[]).map(decodeValue));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) out[key] = decodeValue(item);
  return out;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) out[key] = sortKeys(rec[key]);
  return out;
}

/** Comparison form of an already-encoded value: JSON with sorted keys. */
export function canonicalJson(encoded: unknown): string {
  return JSON.stringify(sortKeys(encoded)) ?? 'null';
}
