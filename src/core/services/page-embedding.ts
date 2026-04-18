export function buildPageCentroid(vectors: Array<Float32Array | null>): Float32Array | null {
  const usable = vectors.filter((vector): vector is Float32Array => vector !== null);
  if (usable.length === 0) return null;

  const out = new Float32Array(usable[0]!.length);
  for (const vector of usable) {
    for (let i = 0; i < vector.length; i++) {
      out[i]! += vector[i]!;
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i]! /= usable.length;
  }
  return out;
}
