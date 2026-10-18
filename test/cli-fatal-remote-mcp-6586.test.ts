/**
 * #6586: on Bun 1.4.3 a refused fetch reads `ECONNREFUSED: Unable to connect.
 * Is the computer able to access the url?` (1.4.2 said only `Unable to
 * connect…`). The fatal seam ran every error through the database access
 * classifier first, so a thin client whose remote MCP host was down printed
 * `GBRAIN_DB_ACCESS conn_refused` and "switch to the transaction pooler …
 * Run: gbrain db-repair". A remote MCP failure renders as itself; a real
 * refused Postgres connection still gets the marker and the db-repair line.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { writeFatalCliError } from '../src/cli/cli-error.ts';
import { RemoteMcpError } from '../src/core/remote-mcp-error.ts';

function stderrOf(run: () => number): { code: number; text: string } {
  const chunks: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write);
  try { return { code: run(), text: chunks.join('') }; } finally { spy.mockRestore(); }
}

describe('the fatal seam on a refused connection', () => {
  test('a remote MCP discovery failure in Bun 1.4.3 wording is not a database access error', () => {
    const error = new RemoteMcpError('network', 'OAuth discovery failed: OAuth discovery network error: ECONNREFUSED: Unable to connect. Is the computer able to access the url?', { mcp_url: 'http://127.0.0.1:9/mcp' });
    const { code, text } = stderrOf(() => writeFatalCliError(error, { argv: ['takes', 'list'] }));
    expect(code).toBe(1);
    expect(text).toContain('Error [unavailable]: OAuth discovery failed');
    expect(text).toContain('Fix: gbrain remote doctor');
    expect(text).not.toContain('GBRAIN_DB_ACCESS');
    expect(text).not.toContain('database_error');
    expect(text).not.toContain('db-repair');
  });

  test('a refused Postgres connection keeps the marker and the db-repair remediation', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const { code, text } = stderrOf(() => writeFatalCliError(error, { argv: ['takes', 'list'], dbUrl: 'postgresql://postgres@127.0.0.1:5432/brain' }));
    expect(code).toBe(1);
    expect(text).toContain('Error [database_error]: connect ECONNREFUSED');
    expect(text).toContain('Run: gbrain db-repair');
  });
});
