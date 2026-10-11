export function mcpServiceOrigin(browserOrigin: string, service?: { port?: number } | null): string {
  const port = service?.port;
  if (Number.isInteger(port) && port! > 0 && port! <= 65535) return `http://127.0.0.1:${port}`;
  return service === undefined && /^https?:\/\//.test(browserOrigin) ? browserOrigin : '';
}
