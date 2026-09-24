/** Strict bounded range transport shared by object-store backends. */
export function rangeBounds(offset: number, length: number, size: number): void {
  if (![offset, length, size].every(n => Number.isSafeInteger(n) && n >= 0) || offset + length > size) {
    throw new Error('Invalid storage range');
  }
}
export function checkContentRange(value: string | null | undefined, offset: number, length: number, size: number): void {
  if (value !== `bytes ${offset}-${offset + length - 1}/${size}`) throw new Error('Unexpected storage Content-Range');
}
export async function boundedBody(body: ReadableStream<Uint8Array>, length: number): Promise<Buffer> {
  const reader = body.getReader();
  const data = Buffer.alloc(length);
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > length) throw new Error('Storage range exceeded requested length');
      data.set(next.value, received - next.value.byteLength);
    }
    if (received !== length) throw new Error('Truncated storage range');
    return data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
