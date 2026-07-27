import { test, expect, describe } from 'bun:test';
import {
  normalizeMcpUrl,
  isLinkLocalOrMetadata,
  validateToken,
  resolveToken,
  isValidName,
  buildClaudeMcpAddArgv,
  buildCodexMcpAddArgv,
  cmdString,
  redactToken,
  buildConnectBlock,
  buildJson,
  runConnect,
  issuerFromMcpUrl,
  type ConnectDeps,
  AGENT_IDS,
  ENV_VAR,
  DEFAULT_SCOPES,
  PLACEHOLDER_TOKEN,
  PLACEHOLDER_SECRET,
  REDACTED,
  LEARN_INSTRUCTION,
} from '../src/commands/connect.ts';
import {
  classifyProbeError,
  extractResultText,
  probeBrainIdentity,
  type ProbeDeps,
} from '../src/core/connect-probe.ts';

describe('normalizeMcpUrl', () => {
  test('bare host:port is rejected with a scheme hint', () => {
    const r = normalizeMcpUrl('brain.example.com:3131');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https:\/\/brain\.example\.com:3131/);
  });

  test('localhost:port (no scheme) is rejected too', () => {
    expect(normalizeMcpUrl('localhost:3131').ok).toBe(false);
  });

  test('https host without path appends /mcp', () => {
    const r = normalizeMcpUrl('https://brain.example.com:3131');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com:3131/mcp' });
  });

  test('existing /mcp is not doubled', () => {
    const r = normalizeMcpUrl('https://brain.example.com/mcp');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com/mcp' });
  });

  test('trailing slash on /mcp/ is tolerated', () => {
    const r = normalizeMcpUrl('https://brain.example.com/mcp/');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com/mcp' });
  });

  test('root path becomes /mcp', () => {
    const r = normalizeMcpUrl('https://brain.example.com/');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com/mcp' });
  });

  test('uppercase scheme/host + /MCP normalize to lowercase canonical', () => {
    const r = normalizeMcpUrl('HTTPS://Brain.Example.COM/MCP');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com/mcp' });
  });

  test('a non-/mcp base path errors and suggests the full URL', () => {
    const r = normalizeMcpUrl('https://brain.example.com/gbrain');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\/gbrain\/mcp/);
  });

  test('credentials in the URL are rejected', () => {
    expect(normalizeMcpUrl('https://user:pass@brain.example.com/mcp').ok).toBe(false);
  });

  test('query strings are rejected', () => {
    expect(normalizeMcpUrl('https://brain.example.com/mcp?key=1').ok).toBe(false);
  });

  test('fragment is stripped', () => {
    const r = normalizeMcpUrl('https://brain.example.com/mcp#frag');
    expect(r).toEqual({ ok: true, url: 'https://brain.example.com/mcp' });
  });

  test('non-http scheme is rejected', () => {
    expect(normalizeMcpUrl('ftp://brain.example.com/mcp').ok).toBe(false);
  });

  test('http on a non-local host warns about plaintext token', () => {
    const r = normalizeMcpUrl('http://brain.example.com/mcp');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toMatch(/unencrypted/i);
  });

  test('http on localhost does not warn', () => {
    const r = normalizeMcpUrl('http://localhost:3131/mcp');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warning).toBeUndefined();
  });

  test('empty input errors', () => {
    expect(normalizeMcpUrl('').ok).toBe(false);
  });

  test('cloud-metadata / link-local hosts are rejected', () => {
    expect(normalizeMcpUrl('http://169.254.169.254/mcp').ok).toBe(false);
    expect(normalizeMcpUrl('http://[fe80::1]/mcp').ok).toBe(false);
    const r = normalizeMcpUrl('http://169.254.169.254/mcp');
    if (!r.ok) expect(r.error).toMatch(/link-local|metadata/i);
  });

  test('localhost and RFC1918/LAN hosts are still allowed (self-hosted brains)', () => {
    expect(normalizeMcpUrl('http://localhost:3131/mcp').ok).toBe(true);
    expect(normalizeMcpUrl('http://192.168.1.50:3131/mcp').ok).toBe(true);
    expect(normalizeMcpUrl('https://10.0.0.5/mcp').ok).toBe(true);
  });

  test('IPv4-mapped IPv6 metadata addresses do not bypass the guard', () => {
    // dotted and hex (a9fe == 169.254) IPv4-mapped forms
    expect(isLinkLocalOrMetadata('::ffff:169.254.169.254')).toBe(true);
    expect(isLinkLocalOrMetadata('::ffff:a9fe:a9fe')).toBe(true);
    expect(isLinkLocalOrMetadata('[::ffff:169.254.169.254]')).toBe(true);
    // a normal mapped LAN/public address is not flagged
    expect(isLinkLocalOrMetadata('::ffff:192.168.1.5')).toBe(false);
  });
});

describe('validateToken', () => {
  test('accepts a normal token', () => {
    expect(validateToken('gbrain_abc123').ok).toBe(true);
  });
  test('rejects empty', () => {
    expect(validateToken('').ok).toBe(false);
    expect(validateToken('   ').ok).toBe(false);
  });
  test('rejects whitespace (newline = header injection)', () => {
    expect(validateToken('abc\ndef').ok).toBe(false);
    expect(validateToken('abc def').ok).toBe(false);
    expect(validateToken('abc\tdef').ok).toBe(false);
  });
  test('rejects control characters', () => {
    expect(validateToken('abc\x00def').ok).toBe(false);
  });
});

describe('resolveToken', () => {
  test('--token flag wins', () => {
    expect(resolveToken({ tokenFlag: 'tok', env: 'envtok', mode: 'print' })).toEqual({ kind: 'literal', token: 'tok' });
  });
  test('env used when no flag', () => {
    expect(resolveToken({ tokenFlag: null, env: 'envtok', mode: 'install' })).toEqual({ kind: 'literal', token: 'envtok' });
  });
  test('print mode without token returns placeholder', () => {
    expect(resolveToken({ tokenFlag: null, env: null, mode: 'print' })).toEqual({ kind: 'placeholder' });
  });
  test('install mode without token errors with a gbrain auth create hint', () => {
    const r = resolveToken({ tokenFlag: null, env: null, mode: 'install' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.error).toMatch(/gbrain auth create/);
      expect(r.error).toMatch(ENV_VAR);
    }
  });
  test('invalid token errors even in print mode', () => {
    expect(resolveToken({ tokenFlag: 'bad tok', env: null, mode: 'print' }).kind).toBe('error');
  });
});

describe('isValidName', () => {
  test('accepts conservative identifiers', () => {
    expect(isValidName('gbrain')).toBe(true);
    expect(isValidName('team-brain_2')).toBe(true);
  });
  test('rejects bad names', () => {
    expect(isValidName('-leading')).toBe(false);
    expect(isValidName('Has Space')).toBe(false);
    expect(isValidName('UPPER')).toBe(false);
    expect(isValidName('')).toBe(false);
    expect(isValidName('semi;colon')).toBe(false);
  });
});

describe('argv + command string', () => {
  test('claude argv shape', () => {
    expect(buildClaudeMcpAddArgv({ name: 'gbrain', url: 'https://h/mcp', headerToken: 'TOK' })).toEqual([
      'mcp', 'add', 'gbrain', '-t', 'http', 'https://h/mcp', '-H', 'Authorization: Bearer TOK',
    ]);
  });
  test('codex argv shape — env-var bearer, no token in argv', () => {
    expect(buildCodexMcpAddArgv({ name: 'gbrain', url: 'https://h/mcp', envVar: ENV_VAR })).toEqual([
      'mcp', 'add', 'gbrain', '--url', 'https://h/mcp', '--bearer-token-env-var', ENV_VAR,
    ]);
  });
  test('command string single-quotes the header (paste-safe)', () => {
    const cmd = cmdString('claude', buildClaudeMcpAddArgv({ name: 'gbrain', url: 'https://h/mcp', headerToken: 'TOK' }));
    expect(cmd).toBe("claude mcp add gbrain -t http https://h/mcp -H 'Authorization: Bearer TOK'");
  });
  test('a token with shell metacharacters cannot trigger command substitution on paste', () => {
    const cmd = cmdString('claude', buildClaudeMcpAddArgv({ name: 'gbrain', url: 'https://h/mcp', headerToken: 'gbrain_$(touch /tmp/pwned)`x`' }));
    // Single-quoted → the $() and backticks are inert literals, not double-quoted.
    expect(cmd).toContain("'Authorization: Bearer gbrain_$(touch /tmp/pwned)`x`'");
    expect(cmd).not.toContain('"Authorization');
  });
});

describe('redactToken', () => {
  test('replaces every occurrence', () => {
    expect(redactToken('a TOK b TOK', 'TOK')).toBe(`a ${REDACTED} b ${REDACTED}`);
  });
  test('null token still scrubs Bearer-shaped values (defense in depth)', () => {
    // Even without the literal token, a transformed Bearer echo is scrubbed.
    expect(redactToken('failed: Bearer gbrain_xyz123', null)).toBe(`failed: Bearer ${REDACTED}`);
  });
  test('Bearer scrub catches a non-exact token echo', () => {
    expect(redactToken('add failed near Bearer SOMETHINGELSE', 'tok')).toContain(`Bearer ${REDACTED}`);
  });
});

describe('buildConnectBlock', () => {
  test('claude-code with a literal token inlines it + learn instruction', () => {
    const block = buildConnectBlock({ agent: 'claude-code', name: 'gbrain', url: 'https://h/mcp', token: 'TOK' });
    expect(block).toContain("claude mcp add gbrain -t http https://h/mcp -H 'Authorization: Bearer TOK'");
    expect(block).toContain(LEARN_INSTRUCTION);
    expect(block).not.toContain(PLACEHOLDER_TOKEN);
    expect(block).toMatch(/long-lived, full-access secret/);
  });
  test('claude-code without a token emits a placeholder + replace hint', () => {
    const block = buildConnectBlock({ agent: 'claude-code', name: 'gbrain', url: 'https://h/mcp', token: null });
    expect(block).toContain(PLACEHOLDER_TOKEN);
    expect(block).toMatch(/gbrain auth create/);
  });
  test('generic agent emits URL + header lines, no claude command', () => {
    const block = buildConnectBlock({ agent: 'generic', name: 'gbrain', url: 'https://h/mcp', token: 'TOK' });
    expect(block).toContain('URL:    https://h/mcp');
    expect(block).toContain('Authorization: Bearer TOK');
    expect(block).not.toContain('claude mcp add');
    expect(block).toContain(LEARN_INSTRUCTION);
  });
  test('codex emits the codex command + env-var export, token only in export', () => {
    const block = buildConnectBlock({ agent: 'codex', name: 'gbrain', url: 'https://h/mcp', token: 'TOK' });
    expect(block).toContain('codex mcp add gbrain --url https://h/mcp --bearer-token-env-var GBRAIN_REMOTE_TOKEN');
    expect(block).toContain('export GBRAIN_REMOTE_TOKEN=TOK');
    // the codex command itself must not carry the token
    expect(block).toMatch(/codex mcp add[^\n]*$/m);
    expect(block).toContain(LEARN_INSTRUCTION);
    expect(block).toMatch(/reads the token from \$GBRAIN_REMOTE_TOKEN/);
  });
  test('codex single-quotes a metachar token in the export line', () => {
    const block = buildConnectBlock({ agent: 'codex', name: 'gbrain', url: 'https://h/mcp', token: 'gbrain_$(x)`y`' });
    expect(block).toContain("export GBRAIN_REMOTE_TOKEN='gbrain_$(x)`y`'");
  });
  test('perplexity emits GUI connector steps with URL + token, no CLI command', () => {
    const block = buildConnectBlock({ agent: 'perplexity', name: 'gbrain', url: 'https://h/mcp', token: 'TOK' });
    expect(block).toMatch(/Settings.+Connectors/);
    expect(block).toContain('URL:    https://h/mcp');
    expect(block).toContain('Token:  TOK');
    expect(block).not.toContain('mcp add');
    expect(block).toContain(LEARN_INSTRUCTION);
    // surfaces the v0.34 remote-reachability footgun (serve --bind 0.0.0.0)
    expect(block).toContain('--bind 0.0.0.0');
    expect(block).toMatch(/docs\/mcp\/PERPLEXITY\.md/);
  });
});

describe('buildJson', () => {
  test('redacts the token by default; claude has a command', () => {
    const j = buildJson({ url: 'https://h/mcp', name: 'gbrain', agent: 'claude-code', token: 'SeKrEt9', showToken: false });
    expect(j.token_present).toBe(true);
    expect(j.token_redacted).toBe(true);
    expect(j.env_var).toBe(ENV_VAR);
    expect(typeof j.command).toBe('string');
    expect(Array.isArray(j.command_argv)).toBe(true);
    expect(JSON.stringify(j)).not.toContain('SeKrEt9');
    expect(JSON.stringify(j)).toContain(REDACTED);
  });
  test('--show-token reveals the literal token', () => {
    const j = buildJson({ url: 'https://h/mcp', name: 'gbrain', agent: 'claude-code', token: 'SeKrEt9', showToken: true });
    expect(j.token_redacted).toBe(false);
    expect(JSON.stringify(j)).toContain('Authorization: Bearer SeKrEt9');
  });
  test('no token → placeholder, token_present false', () => {
    const j = buildJson({ url: 'https://h/mcp', name: 'gbrain', agent: 'claude-code', token: null, showToken: false });
    expect(j.token_present).toBe(false);
    expect(JSON.stringify(j)).toContain(PLACEHOLDER_TOKEN);
  });
  test('codex command carries the env-var name, never the token (even with --show-token)', () => {
    const j = buildJson({ url: 'https://h/mcp', name: 'gbrain', agent: 'codex', token: 'SeKrEt9', showToken: true });
    expect(j.command).toContain('--bearer-token-env-var GBRAIN_REMOTE_TOKEN');
    expect(j.command).not.toContain('SeKrEt9'); // token is in the env-var, not the command
    expect(j.header).toContain('Authorization: Bearer SeKrEt9'); // header field carries it under --show-token
  });
  test('perplexity has no runnable command', () => {
    const j = buildJson({ url: 'https://h/mcp', name: 'gbrain', agent: 'perplexity', token: 'TOK', showToken: false });
    expect(j.command).toBeNull();
    expect(j.command_argv).toBeNull();
    expect(j.header).toContain('Authorization: Bearer');
  });
});

describe('OAuth helpers', () => {
  test('issuerFromMcpUrl strips /mcp', () => {
    expect(issuerFromMcpUrl('https://brain.example.com:3131/mcp')).toBe('https://brain.example.com:3131');
    expect(issuerFromMcpUrl('https://brain.example.com/mcp')).toBe('https://brain.example.com');
  });

  test('perplexity oauth block: issuer + client id/secret, no bearer header', () => {
    const block = buildConnectBlock({
      agent: 'perplexity', name: 'gbrain', url: 'https://h/mcp', token: null,
      oauth: { issuer: 'https://h', clientId: 'gbrain_cl_x', clientSecret: 'gbrain_cs_y' },
    });
    expect(block).toMatch(/Settings.+Connectors/);
    expect(block).toContain('Issuer URL:    https://h');
    expect(block).toContain('Client ID:     gbrain_cl_x');
    expect(block).toContain('Client Secret: gbrain_cs_y');
    expect(block).toContain('OAuth 2.1 (client credentials)');
    expect(block).not.toContain('Authorization: Bearer');
    expect(block).toContain(LEARN_INSTRUCTION);
  });

  test('generic oauth block emits the OAuth fields', () => {
    const block = buildConnectBlock({
      agent: 'generic', name: 'gbrain', url: 'https://h/mcp', token: null,
      oauth: { issuer: 'https://h', clientId: 'gbrain_cl_x', clientSecret: 'gbrain_cs_y' },
    });
    expect(block).toContain('Issuer URL:    https://h');
    expect(block).toContain('Client ID:     gbrain_cl_x');
    expect(block).toContain('Client Secret: gbrain_cs_y');
  });

  test('oauth block placeholders a missing secret', () => {
    const block = buildConnectBlock({
      agent: 'perplexity', name: 'gbrain', url: 'https://h/mcp', token: null,
      oauth: { issuer: 'https://h', clientId: 'gbrain_cl_x', clientSecret: null },
    });
    expect(block).toContain(PLACEHOLDER_SECRET);
  });

  test('buildJson oauth: redacts the secret by default, exposes issuer + scopes', () => {
    const j = buildJson({
      url: 'https://h/mcp', name: 'gbrain', agent: 'perplexity', token: null, showToken: false,
      oauth: { issuer: 'https://h', clientId: 'gbrain_cl_x', clientSecret: 'SeKrEt9' }, scopes: 'read',
    });
    expect(j.auth).toBe('oauth');
    expect(j.issuer_url).toBe('https://h');
    expect(j.client_id).toBe('gbrain_cl_x');
    expect(j.client_secret).toBe(REDACTED);
    expect(j.secret_redacted).toBe(true);
    expect(j.scopes).toBe('read');
    expect(j.command).toBeNull();
    expect(JSON.stringify(j)).not.toContain('SeKrEt9');
  });

  test('buildJson oauth --show-token reveals the secret', () => {
    const j = buildJson({
      url: 'https://h/mcp', name: 'gbrain', agent: 'perplexity', token: null, showToken: true,
      oauth: { issuer: 'https://h', clientId: 'gbrain_cl_x', clientSecret: 'SeKrEt9' },
    });
    expect(j.client_secret).toBe('SeKrEt9');
    expect(j.scopes).toBe(DEFAULT_SCOPES);
  });
});

// ---------------------------------------------------------------------------
// connect-probe
// ---------------------------------------------------------------------------

describe('classifyProbeError', () => {
  test('timeout/abort', () => {
    expect(classifyProbeError('timeout after 15000ms')).toBe('timeout');
    expect(classifyProbeError('The operation was aborted')).toBe('timeout');
  });
  test('auth', () => {
    expect(classifyProbeError('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyProbeError('403 forbidden')).toBe('auth');
  });
  test('unreachable', () => {
    expect(classifyProbeError('fetch failed')).toBe('unreachable');
    expect(classifyProbeError('getaddrinfo ENOTFOUND brain.example.com')).toBe('unreachable');
    expect(classifyProbeError('connect ECONNREFUSED 127.0.0.1:3131')).toBe('unreachable');
    // MCP SDK / undici friendly wrapper for a refused connection.
    expect(classifyProbeError('Unable to connect. Is the computer able to access the url?')).toBe('unreachable');
  });
  test('unknown fallback', () => {
    expect(classifyProbeError('something weird')).toBe('unknown');
  });
});

describe('extractResultText', () => {
  test('joins text content entries', () => {
    expect(extractResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
  test('non-array → empty', () => {
    expect(extractResultText(null)).toBe('');
    expect(extractResultText({})).toBe('');
  });
});

describe('probeBrainIdentity (injected deps)', () => {
  test('ok result extracts identity text', async () => {
    const deps: ProbeDeps = {
      connectAndCall: async () => ({ content: [{ type: 'text', text: 'brain: alice-example' }] }),
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { deps });
    expect(r).toEqual({ ok: true, identity: 'brain: alice-example' });
  });
  test('isError with 401 → auth', async () => {
    const deps: ProbeDeps = {
      connectAndCall: async () => ({ isError: true, content: [{ type: 'text', text: 'HTTP 401' }] }),
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth');
  });
  test('thrown ENOTFOUND → unreachable', async () => {
    const deps: ProbeDeps = {
      connectAndCall: async () => { throw new Error('getaddrinfo ENOTFOUND h'); },
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unreachable');
  });
  test('isError with a non-auth message → tool_error', async () => {
    const deps: ProbeDeps = {
      connectAndCall: async () => ({ isError: true, content: [{ type: 'text', text: 'tool blew up: bad arguments' }] }),
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tool_error');
  });
  test('timeout timer fires → reason timeout (deterministic, no real sleep)', async () => {
    const deps: ProbeDeps = {
      connectAndCall: (_u, _t, signal) => new Promise((_res, rej) => {
        signal.addEventListener('abort', () => rej(new Error('The operation was aborted')));
      }),
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { timeoutMs: 10, deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });
  test('a connectAndCall that ignores the abort signal still times out (Promise.race)', async () => {
    // Simulates a transport whose connect()/SSE handshake never honors the
    // signal — the probe must still resolve via the timeout race, not hang.
    const deps: ProbeDeps = {
      connectAndCall: () => new Promise(() => { /* never settles, ignores signal */ }),
    };
    const r = await probeBrainIdentity('https://h/mcp', 'TOK', { timeoutMs: 15, deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// runConnect orchestrator (install path) — inject deps, stub process.exit
// ---------------------------------------------------------------------------

function captureConsole() {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  return {
    out, err,
    restore() { console.log = origLog; console.error = origErr; },
  };
}

async function runWithExitCapture(args: string[], deps: ConnectDeps): Promise<{ exitCode?: number; out: string[]; err: string[] }> {
  const cap = captureConsole();
  const origExit = process.exit;
  let exitCode: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.exit = ((c?: number) => { exitCode = c ?? 0; throw new Error('__EXIT__'); }) as any;
  try {
    await runConnect(args, deps);
  } catch (e) {
    if ((e as Error).message !== '__EXIT__') { cap.restore(); process.exit = origExit; throw e; }
  } finally {
    cap.restore();
    process.exit = origExit;
  }
  return { exitCode, out: cap.out, err: cap.err };
}

function installDeps(over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    isTTY: () => false,
    promptYesNo: async () => true,
    hasBinary: () => true,
    runBinary: (_binary, argv) => (argv[1] === 'get' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    probe: async () => ({ ok: true, identity: 'brain: alice-example' }),
    env: () => undefined, // tests control the env; real GBRAIN_REMOTE_TOKEN must not leak in
    registerOAuthClient: () => ({ ok: true, clientId: 'gbrain_cl_minted', clientSecret: 'gbrain_cs_minted' }),
    ...over,
  };
}

describe('runConnect --install', () => {
  test('happy path: adds server, verifies, prints learn instruction', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_tok', '--install', '--yes'],
      installDeps(),
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.err.join('\n')).toMatch(/Added MCP server 'gbrain'/);
    expect(r.err.join('\n')).toMatch(/Verified/);
    expect(r.err.join('\n')).toContain(LEARN_INSTRUCTION);
  });

  test('probe failure warns + exits 1 + never echoes the token', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_secret', '--install', '--yes'],
      installDeps({ probe: async () => ({ ok: false, reason: 'auth', message: 'HTTP 401 for gbrain_secret' }) }),
    );
    expect(r.exitCode).toBe(1);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).toMatch(/did not verify \(auth\)/);
    expect(all).not.toContain('gbrain_secret');
    expect(all).toContain(REDACTED);
  });

  test('missing claude binary fails fast', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install', '--yes'],
      installDeps({ hasBinary: () => false }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/not found on PATH/);
  });

  test('existing server name without --force is refused', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install', '--yes'],
      installDeps({ runBinary: () => ({ code: 0, stdout: '', stderr: '' }) }), // get returns 0 → exists
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/already exists/);
  });

  test('install without a token errors with the auth-create hint', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--install', '--yes'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/gbrain auth create/);
  });

  test('--force replaces an existing server then verifies', async () => {
    const calls: string[][] = [];
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install', '--yes', '--force'],
      installDeps({
        runBinary: (_b, argv) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; }, // get→0 (exists), remove→0, add→0
      }),
    );
    expect(r.exitCode).toBeUndefined();
    expect(calls.some((a) => a[1] === 'remove')).toBe(true);
    expect(calls.some((a) => a[1] === 'add')).toBe(true);
    expect(r.err.join('\n')).toMatch(/Added MCP server/);
  });

  test('--force remove failure aborts + redacts the token', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_secret', '--install', '--yes', '--force'],
      installDeps({
        runBinary: (_b, argv) => (argv[1] === 'remove'
          ? { code: 1, stdout: '', stderr: 'remove failed near gbrain_secret' }
          : { code: 0, stdout: '', stderr: '' }),
      }),
    );
    expect(r.exitCode).toBe(1);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).toMatch(/Could not replace/);
    expect(all).not.toContain('gbrain_secret');
  });

  test('claude mcp add failure aborts + redacts the token', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_secret', '--install', '--yes'],
      installDeps({
        runBinary: (_b, argv) => (argv[1] === 'add'
          ? { code: 1, stdout: '', stderr: 'add blew up with gbrain_secret' }
          : { code: 1, stdout: '', stderr: '' }), // get→1 (not exists)
      }),
    );
    expect(r.exitCode).toBe(1);
    const all = [...r.out, ...r.err].join('\n');
    expect(all).toMatch(/'claude mcp add' failed/);
    expect(all).not.toContain('gbrain_secret');
  });

  test('TTY prompt decline aborts without adding', async () => {
    const calls: string[][] = [];
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install'], // no --yes, TTY on
      installDeps({
        isTTY: () => true,
        promptYesNo: async () => false,
        runBinary: (_b, argv) => { calls.push(argv); return { code: argv[1] === 'get' ? 1 : 0, stdout: '', stderr: '' }; },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/Aborted/);
    expect(calls.some((a) => a[1] === 'add')).toBe(false);
  });

  test('--install with --agent generic is rejected', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install', '--yes', '--agent', 'generic'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/--install supports claude-code and codex/);
  });

  test('--install with --agent perplexity is rejected (GUI connector)', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install', '--yes', '--agent', 'perplexity'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/Perplexity Computer is set up through its own UI/);
  });

  test('--agent codex --install runs the codex CLI and hints the env var', async () => {
    const calls: Array<{ binary: string; argv: string[] }> = [];
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_tok', '--install', '--yes', '--agent', 'codex'],
      installDeps({
        runBinary: (binary, argv) => { calls.push({ binary, argv }); return { code: argv[1] === 'get' ? 1 : 0, stdout: '', stderr: '' }; },
        env: () => undefined, // GBRAIN_REMOTE_TOKEN not set → expect the export hint
      }),
    );
    expect(r.exitCode).toBeUndefined();
    // Uses the codex binary with the env-var bearer form (no token in argv).
    const add = calls.find((c) => c.argv[1] === 'add');
    expect(add?.binary).toBe('codex');
    expect(add?.argv).toEqual(['mcp', 'add', 'gbrain', '--url', 'https://brain.example.com/mcp', '--bearer-token-env-var', 'GBRAIN_REMOTE_TOKEN']);
    expect(JSON.stringify(add?.argv)).not.toContain('gbrain_tok');
    expect(r.err.join('\n')).toMatch(/export GBRAIN_REMOTE_TOKEN/);
    expect(r.err.join('\n')).toMatch(/Verified/);
  });

  test('--agent codex --install skips the env hint when GBRAIN_REMOTE_TOKEN already matches', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_tok', '--install', '--yes', '--agent', 'codex'],
      installDeps({ env: (n) => (n === 'GBRAIN_REMOTE_TOKEN' ? 'gbrain_tok' : undefined) }),
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.err.join('\n')).not.toMatch(/Add this to your shell profile/);
  });

  test('non-interactive --install without --yes is refused', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'tok', '--install'], // isTTY false (default), no --yes
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/requires --yes/);
  });

  test('a flag-shaped --token value is rejected (no silent swallow)', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', '--install'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/--token requires a value/);
  });
});

describe('runConnect print mode', () => {
  test('prints the block to stdout with the literal token', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_tok'],
      installDeps(),
    );
    expect(r.exitCode).toBeUndefined();
    expect(r.out.join('\n')).toContain("claude mcp add gbrain -t http https://brain.example.com/mcp -H 'Authorization: Bearer gbrain_tok'");
  });

  test('--json redacts the token', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--token', 'gbrain_secret', '--json'],
      installDeps(),
    );
    const j = JSON.parse(r.out.join('\n'));
    expect(j.token_redacted).toBe(true);
    expect(r.out.join('\n')).not.toContain('gbrain_secret');
  });

  test('--help prints command-specific HELP, no exit', async () => {
    const r = await runWithExitCapture(['--help'], installDeps());
    expect(r.exitCode).toBeUndefined();
    expect(r.out.join('\n')).toMatch(/gbrain connect/);
  });

  test('unknown --agent fails fast', async () => {
    const r = await runWithExitCapture(['https://h/mcp', '--token', 't', '--agent', 'bogus'], installDeps());
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/Unknown --agent/);
  });

  test('invalid --name fails fast', async () => {
    const r = await runWithExitCapture(['https://h/mcp', '--token', 't', '--name', 'Bad Name'], installDeps());
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/Invalid --name/);
  });

  test('bad URL exits 1 via the orchestrator', async () => {
    const r = await runWithExitCapture(['brain.example.com:3131', '--token', 't'], installDeps());
    expect(r.exitCode).toBe(1);
  });

  test('http non-local prints the plaintext-token warning but still proceeds', async () => {
    const r = await runWithExitCapture(['http://brain.example.com/mcp', '--token', 't'], installDeps());
    expect(r.exitCode).toBeUndefined();
    expect(r.err.join('\n')).toMatch(/unencrypted/i);
  });

  test('invalid --timeout-ms falls back to the default (probe receives it)', async () => {
    let seen = -1;
    await runWithExitCapture(
      ['https://h/mcp', '--token', 't', '--install', '--yes', '--timeout-ms', 'abc'],
      installDeps({ probe: async (_u, _t, ms) => { seen = ms; return { ok: true, identity: 'ok' }; } }),
    );
    expect(seen).toBe(15000);
  });

  test('--agent codex print mode emits the codex block', async () => {
    const r = await runWithExitCapture(['https://brain.example.com/mcp', '--token', 'gbrain_tok', '--agent', 'codex'], installDeps());
    expect(r.exitCode).toBeUndefined();
    const out = r.out.join('\n');
    expect(out).toContain('codex mcp add gbrain --url https://brain.example.com/mcp --bearer-token-env-var GBRAIN_REMOTE_TOKEN');
    expect(out).toContain('export GBRAIN_REMOTE_TOKEN=gbrain_tok');
  });

  test('--agent perplexity print mode emits GUI connector steps', async () => {
    const r = await runWithExitCapture(['https://brain.example.com/mcp', '--token', 'gbrain_tok', '--agent', 'perplexity'], installDeps());
    expect(r.exitCode).toBeUndefined();
    expect(r.out.join('\n')).toMatch(/Settings.+Connectors/);
  });
});

describe('AGENT_IDS', () => {
  test('exposes the four supported agents', () => {
    expect(AGENT_IDS).toEqual(['claude-code', 'codex', 'perplexity', 'generic']);
  });
});

describe('LEARN_INSTRUCTION names only real MCP tools', () => {
  // The self-orientation block is pasted into a connected agent verbatim. Every
  // tool it names MUST be MCP-exposed, or the agent calls an "unknown tool".
  // The exposed set is pinned end-to-end by test/e2e/serve-stdio-roundtrip.ts.
  test('names put_page (the real MCP write tool), not capture (CLI-only)', () => {
    expect(LEARN_INSTRUCTION).toContain('put_page');
    // `capture` is a CLI-only convenience wrapper, not an MCP tool — naming it
    // here told connected agents to call a tool the server does not expose.
    expect(LEARN_INSTRUCTION).not.toContain('capture');
  });
  test('still steers the agent to get_brain_identity + list_skills + brain-first search', () => {
    expect(LEARN_INSTRUCTION).toContain('get_brain_identity');
    expect(LEARN_INSTRUCTION).toContain('list_skills');
    expect(LEARN_INSTRUCTION.toLowerCase()).toContain('search the brain before');
  });
});

describe('runConnect --oauth', () => {
  test('perplexity --oauth with BYO client id/secret prints the OAuth connector block', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--client-id', 'gbrain_cl_x', '--client-secret', 'gbrain_cs_y'],
      installDeps(),
    );
    expect(r.exitCode).toBeUndefined();
    const out = r.out.join('\n');
    expect(out).toContain('Issuer URL:    https://brain.example.com');
    expect(out).toContain('Client ID:     gbrain_cl_x');
    expect(out).toContain('Client Secret: gbrain_cs_y');
  });

  test('perplexity --oauth --register mints a client via the host and prints it', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--register'],
      installDeps(), // registerOAuthClient → gbrain_cl_minted / gbrain_cs_minted
    );
    expect(r.exitCode).toBeUndefined();
    const out = r.out.join('\n');
    expect(out).toContain('Client ID:     gbrain_cl_minted');
    expect(out).toContain('Client Secret: gbrain_cs_minted');
  });

  test('perplexity --oauth --register --json redacts the secret by default', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--register', '--json'],
      installDeps({ registerOAuthClient: () => ({ ok: true, clientId: 'gbrain_cl_x', clientSecret: 'gbrain_cs_secret' }) }),
    );
    const j = JSON.parse(r.out.join('\n'));
    expect(j.auth).toBe('oauth');
    expect(j.client_secret).toBe(REDACTED);
    expect(r.out.join('\n')).not.toContain('gbrain_cs_secret');
  });

  test('--oauth without creds or --register fails with guidance', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/--register/);
    expect(r.err.join('\n')).toMatch(/--client-id/);
  });

  test('--oauth with only --client-id fails (needs both)', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--client-id', 'gbrain_cl_x'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/BOTH --client-id and --client-secret/);
  });

  test('register failure surfaces the manual register-client command', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--register'],
      installDeps({ registerOAuthClient: () => ({ ok: false, message: 'No database connection' }) }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/gbrain auth register-client/);
  });

  test('--oauth is rejected for claude-code (uses bearer)', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'claude-code', '--oauth', '--register'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/connector-style/);
  });

  test('--oauth is rejected for codex (uses bearer)', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'codex', '--oauth', '--register'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/connector-style/);
  });

  test('--oauth + --install is rejected', async () => {
    const r = await runWithExitCapture(
      ['https://brain.example.com/mcp', '--agent', 'perplexity', '--oauth', '--register', '--install', '--yes'],
      installDeps(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.err.join('\n')).toMatch(/--install is not supported with --oauth/);
  });
});
