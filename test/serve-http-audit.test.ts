import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  classifyMcpAuditStatusFromHttpCode,
  classifySuccessfulMcpAuditStatus,
  inferMcpAuditOperation,
  normalizeMcpAuditStatus,
} from '../src/commands/serve-http.ts';

describe('serve-http MCP audit status classification', () => {
  test('does not trust spoofed dry_run request params', () => {
    // The classifier only sees the operation result, not caller-controlled args.
    // A read/list operation called with { dry_run: true } still audits success
    // unless the handler itself reports a dry-run outcome.
    expect(classifySuccessfulMcpAuditStatus({ pages: [], total: 0 })).toBe('success');
  });

  test('marks operation result dry_run: true as dry_run', () => {
    expect(classifySuccessfulMcpAuditStatus({ dry_run: true, would_write: true })).toBe('dry_run');
  });

  test('marks operation result status=dry_run as dry_run', () => {
    expect(classifySuccessfulMcpAuditStatus({ status: 'dry_run', changes: [] })).toBe('dry_run');
  });

  test('does not treat falsy dry_run field as dry_run', () => {
    expect(classifySuccessfulMcpAuditStatus({ dry_run: false, status: 'success' })).toBe('success');
  });

  test('normalizes legacy and unexpected statuses into the approved taxonomy', () => {
    expect(normalizeMcpAuditStatus('auth_failed')).toBe('unauthorized');
    expect(normalizeMcpAuditStatus('insufficient_scope')).toBe('forbidden');
    expect(normalizeMcpAuditStatus('rate_limited')).toBe('validation_error');
  });

  test('classifies unhandled HTTP responses without inventing statuses', () => {
    expect(classifyMcpAuditStatusFromHttpCode(401)).toBe('unauthorized');
    expect(classifyMcpAuditStatusFromHttpCode(403)).toBe('forbidden');
    expect(classifyMcpAuditStatusFromHttpCode(413)).toBe('validation_error');
    expect(classifyMcpAuditStatusFromHttpCode(500)).toBe('error');
    expect(classifyMcpAuditStatusFromHttpCode(204)).toBe('success');
  });
});

describe('serve-http MCP audit operation inference', () => {
  test('logs real tool operation names instead of tools/call', () => {
    expect(inferMcpAuditOperation({ method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'secret' } } })).toBe('get_page');
    expect(inferMcpAuditOperation({ method: 'tools/call', params: { name: 'auth.create_token', arguments: { name: 'agent' } } })).toBe('auth.create_token');
  });

  test('keeps non-tool MCP method names and falls back safely', () => {
    expect(inferMcpAuditOperation({ method: 'tools/list' })).toBe('tools/list');
    expect(inferMcpAuditOperation({ method: 'notifications/initialized' })).toBe('notifications/initialized');
    expect(inferMcpAuditOperation({ method: 'tools/call', params: { arguments: { slug: 'nope' } } })).toBe('unknown');
    expect(inferMcpAuditOperation('not-json')).toBe('unknown');
  });
});

describe('serve-http MCP audit row shape', () => {
  test('mcp_request_log inserts never include params/raw payload columns', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    const inserts = [...source.matchAll(/INSERT INTO mcp_request_log \(([^)]*)\)/g)].map(m => m[1]);
    expect(inserts.length).toBeGreaterThan(0);
    for (const columns of inserts) {
      expect(columns).not.toMatch(/\bparams\b/);
      expect(columns).not.toMatch(/\berror_message\b/);
      expect(columns).toMatch(/\bclient_transport\b/);
    }
  });

  test('active /mcp route uses one audit helper plus fallback for unhandled paths', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    const inserts = [...source.matchAll(/INSERT INTO mcp_request_log \(([^)]*)\)/g)];
    expect(inserts.length).toBe(1);
    expect(source).toContain("app.post('/mcp', auditUnloggedMcpRequest, express.json");
    expect(source).toContain('res.locals.mcpAuditLogged = true');
    expect(source).toContain("await logMcpAudit(res, authInfo.clientId, agentName, 'tools/list', 'success', latency)");
    expect(source).toContain('inferMcpAuditOperation(req.body)');
  });

  test('admin SSE MCP events do not broadcast request params', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(source).not.toContain('params: broadcastParams');
  });

  test('admin request browser does not read legacy params or error_message fields', () => {
    const source = readFileSync('src/commands/serve-http.ts', 'utf8');
    const requestBrowser = source.slice(
      source.indexOf("app.get('/admin/api/requests'"),
      source.indexOf('// Legacy API keys'),
    );
    expect(requestBrowser).not.toMatch(/\bparams\b/);
    expect(requestBrowser).not.toMatch(/\berror_message\b/);
    expect(requestBrowser).toContain('client_transport');
  });
});
