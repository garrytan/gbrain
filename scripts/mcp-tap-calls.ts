/**
 * Read the JSON-RPC logs scripts/ci-mcp-tap.sh writes in front of gbrain's
 * stdio MCP server (#8002): `<log>` holds what the client sent, `<log>.responses`
 * what the server answered. A line that is not JSON-RPC is ignored.
 */
type Message = { id?: unknown; method?: unknown; params?: { name?: unknown }; result?: { isError?: unknown }; error?: unknown };

function messages(log: string): Message[] {
  const out: Message[] = [];
  for (const line of log.split('\n')) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) if (msg && typeof msg === 'object') out.push(msg as Message);
  }
  return out;
}

/** The name of every tool the client called (`tools/call`), in order. */
export function tapToolCalls(log: string): string[] {
  return tapToolResults(log, '').map(c => c.name);
}

/**
 * Every tool call with whether gbrain answered it with a result (#8011): a JSON-RPC `error`, a result with
 * `isError: true` or no answer is not ok. The server restarts its ids with each process, so a call is ok only
 * when every request carrying its id got an answer and every answer is a successful result: neither a
 * colliding error nor another request's answer reads as success.
 */
export function tapToolResults(requests: string, responses: string): { name: string; ok: boolean }[] {
  const asked = new Map<string, number>();
  for (const m of messages(requests)) {
    if (m.id === undefined || m.id === null || m.method === undefined) continue;
    const key = JSON.stringify(m.id);
    asked.set(key, (asked.get(key) ?? 0) + 1);
  }
  const answers = new Map<string, Message[]>();
  for (const m of messages(responses)) {
    if (m.id === undefined || m.id === null || m.method !== undefined) continue;
    const key = JSON.stringify(m.id);
    answers.set(key, [...(answers.get(key) ?? []), m]);
  }
  return messages(requests).filter(m => m.method === 'tools/call' && typeof m.params?.name === 'string').map(m => {
    const got = answers.get(JSON.stringify(m.id)) ?? [];
    const ok = got.length > 0 && got.length >= asked.get(JSON.stringify(m.id))! && got.every(r => r.error === undefined && r.result !== undefined && r.result?.isError !== true);
    return { name: m.params!.name as string, ok };
  });
}
