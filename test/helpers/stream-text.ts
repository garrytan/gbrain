/**
 * Drain a child's stdout/stderr into a string from the moment it is spawned.
 *
 * Racing `reader.read()` against a timer loses output: a read the timer beat
 * is still queued on the reader, so the next chunk the child writes resolves
 * that abandoned read and nobody keeps its bytes. A gateway that is quiet for
 * a second while it loads plugins and then prints `[gateway] ready` in one
 * chunk has that line eaten (test/stream-text.test.ts pins it). One pump per
 * stream, started once, is the only reader; callers poll `text`.
 */
export interface PumpedText {
  readonly text: string;
}

export function pumpText(stream: ReadableStream<Uint8Array>): PumpedText {
  const decoder = new TextDecoder();
  let text = '';
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
  })().catch(() => {});
  return { get text() { return text; } };
}

/** Polls until `needle` appears in the pumped text or `timeoutMs` passes; returns whether it appeared. */
export async function waitForText(pumped: PumpedText, needle: string, timeoutMs: number, everyMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pumped.text.includes(needle) && Date.now() < deadline) await Bun.sleep(everyMs);
  return pumped.text.includes(needle);
}
