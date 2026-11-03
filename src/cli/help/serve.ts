/** D3 curated help for `gbrain serve` (flags read by src/commands/serve.ts, src/mcp/surface.ts, src/core/serve-fail-fast.ts). */
import type { CliHelpSpec } from '../command-table.ts';

export const help: CliHelpSpec = {
  summary: 'Run the MCP server: stdio by default, or OAuth 2.1 HTTP with --http.',
  usage: [
    'gbrain serve [--surface verbs|starter|full] [--advertise verbs|starter|full] [--access full|read-only] [--source-guard] [--stdio-idle-timeout <s>] [--fail-fast] [--cli-socket]',
    'gbrain serve --http [--port <n>] [--bind <host>] [--public-url <url>] [--token-ttl <s>] [--enable-dcr] [--surface …] [--advertise …]',
  ].join('\n'),
  flags: [
    { name: '--http', type: 'boolean', desc: 'Serve over HTTP with OAuth 2.1, the admin dashboard and per-token scopes.' },
    { name: '--surface', type: 'enum', values: ['verbs', 'starter', 'full'], desc: 'Tool surface: the 7 memory verbs, the daily-driver ops, or every operation. stdio: env GBRAIN_SURFACE > --surface > config mcp_surface > full; --http ignores GBRAIN_SURFACE.' },
    { name: '--advertise', type: 'enum', values: ['verbs', 'starter', 'full'], desc: 'The tools tools/list shows, narrower than --surface; every tool --surface allows stays callable and request_tools (always listed) describes the rest. Overrides config mcp.advertised_surface. New stdio registrations from gbrain setup and gbrain bootstrap hooks pass --advertise verbs.' },
    { name: '--access', type: 'enum', values: ['full', 'read-only'], desc: 'stdio only: read-only exposes read-scoped, non-mutating operations.' },
    { name: '--source-guard', type: 'boolean', desc: 'stdio only: refuse writes unless the source binding is deliberate or unambiguous.' },
    { name: '--stdio-idle-timeout', type: 'number', desc: 'stdio only: exit after this many idle seconds (0 = never).' },
    { name: '--fail-fast', type: 'boolean', desc: 'Exit non-zero with the classified error when the database is unreachable (no degraded mode).' },
    { name: '--cli-socket', type: 'boolean', desc: 'Postgres only, off by default (or config serve.cli_socket): answer this user\'s CLI search, query, get and recall over a private Unix socket in $GBRAIN_HOME/.gbrain/run/ instead of a cold connection per call.' },
    { name: '--port', type: 'number', desc: 'HTTP port (default 3131).' },
    { name: '--bind', type: 'string', desc: 'HTTP interface to listen on (default 127.0.0.1; 0.0.0.0 for remote access).' },
    { name: '--public-url', type: 'string', desc: 'The externally reachable base URL (OAuth issuer and redirect checks).' },
    { name: '--token-ttl', type: 'number', desc: 'Access-token lifetime in seconds (default 3600).' },
    { name: '--enable-dcr', type: 'boolean', desc: 'Allow OAuth dynamic client registration (consent-bearing authorization_code clients).' },
    { name: '--enable-dcr-insecure', type: 'boolean', desc: 'Also allow consent-bypassing client_credentials DCR clients (implies --enable-dcr).' },
    { name: '--log-full-params', type: 'boolean', desc: 'Log raw request payloads instead of redacted summaries (debug only).' },
    { name: '--suppress-bootstrap-token', type: 'boolean', desc: 'Never print the admin bootstrap token (pair with GBRAIN_ADMIN_BOOTSTRAP_TOKEN).' },
    { name: '--print-admin-token', type: 'boolean', desc: 'Print the generated admin token even when stdout is not a TTY.' },
  ],
  examples: [
    'gbrain serve',
    'gbrain serve --surface starter --access read-only',
    'gbrain serve --cli-socket',
    'gbrain serve --http --port 3131 --public-url https://brain.example.com',
  ],
};
