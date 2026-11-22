/** Worker: exact top-10 (by dot product = cosine on unit vectors) for a range of queries. */

interface Job { vectors: SharedArrayBuffer; queries: SharedArrayBuffer; dims: number; rows: number; q0: number; q1: number }

(self as unknown as Worker).onmessage = (event: MessageEvent<Job>) => {
  const { dims, rows, q0, q1 } = event.data;
  const vectors = new Float32Array(event.data.vectors);
  const queries = new Float32Array(event.data.queries);
  const result: number[][] = [];
  for (let q = q0; q < q1; q++) {
    const qoff = q * dims;
    const bestScore = new Float64Array(10).fill(-Infinity);
    const bestRow = new Int32Array(10).fill(-1);
    let floor = -Infinity;
    for (let r = 0; r < rows; r++) {
      const off = r * dims;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < dims; d += 4) {
        s0 += vectors[off + d]! * queries[qoff + d]!;
        s1 += vectors[off + d + 1]! * queries[qoff + d + 1]!;
        s2 += vectors[off + d + 2]! * queries[qoff + d + 2]!;
        s3 += vectors[off + d + 3]! * queries[qoff + d + 3]!;
      }
      const score = s0 + s1 + s2 + s3;
      if (score <= floor) continue;
      let slot = 9;
      while (slot > 0 && bestScore[slot - 1]! < score) {
        bestScore[slot] = bestScore[slot - 1]!;
        bestRow[slot] = bestRow[slot - 1]!;
        slot--;
      }
      bestScore[slot] = score;
      bestRow[slot] = r;
      floor = bestScore[9]!;
    }
    result.push(Array.from(bestRow));
  }
  postMessage({ q0, result });
};
