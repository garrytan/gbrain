/**
 * Read the JSON-RPC log scripts/ci-mcp-tap.sh writes in front of gbrain's
 * stdio MCP server, and return the name of every tool the client called
 * (`tools/call`), in order (#8002). A line that is not JSON-RPC is ignored.
 */
export function tapToolCalls(log: string): string[] {
  const names: string[] = [];
  for (const line of log.split('\n')) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      const m = msg as { method?: unknown; params?: { name?: unknown } } | null;
      if (m?.method === 'tools/call' && typeof m.params?.name === 'string') names.push(m.params.name);
    }
  }
  return names;
}
