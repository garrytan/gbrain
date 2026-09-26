/**
 * Pure-function contracts of src/core/tailscale.ts: status/serve-status
 * parsing, binary discovery, install plans, argv builders and the stderr
 * classifier that `gbrain mcp expose` turns into operator fixes. No tailscale
 * binary, no subprocess, no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyTailscaleError, defaultCommandRunner, findProxiedHandler, findRootHandlers, findTailscaleBinary, isSystemTailscaleBinary, normalizeDnsName,
  parseServeStatusStrict, parseTailscaleStatus, publicUrlFromDnsName, tailscaleInstallPlan, tailscaleLoginArgv, tailscaleManualLoginCommand, tailscaleServeArgv, tailscaleServeOffArgv,
  TAILSCALE_ACCEPT_DNS_COMMAND, TAILSCALE_ADMIN_ACL_URL, TAILSCALE_ADMIN_DNS_URL, TAILSCALE_BINARY_CANDIDATES, TAILSCALE_DOWNLOAD_URL,
  TAILSCALE_FUNNEL_CAPABILITY, TAILSCALE_FUNNEL_KB_URL, type CommandRunOptions,
} from '../src/core/tailscale.ts';

const STATUS_DOC = {
  Version: '1.80.0-t123',
  BackendState: 'Running',
  Self: { DNSName: 'Your-Machine.your-tailnet.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a::1'] },
  CurrentTailnet: { MagicDNSEnabled: true },
  CertDomains: ['your-machine.your-tailnet.ts.net'],
};

const SERVE_DOC = {
  TCP: { '443': { HTTPS: true } },
  Web: { 'your-machine.your-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3131' } } } },
  AllowFunnel: { 'your-machine.your-tailnet.ts.net:443': true },
};

describe('parseTailscaleStatus', () => {
  test('reads BackendState, DNSName (trailing dot stripped, lowercased), IPs, MagicDNS, CertDomains, Version', () => {
    const st = parseTailscaleStatus(JSON.stringify(STATUS_DOC))!;
    expect(st.backendState).toBe('Running');
    expect(st.dnsName).toBe('your-machine.your-tailnet.ts.net');
    expect(st.tailscaleIps).toEqual(['100.101.102.103', 'fd7a::1']);
    expect(st.magicDnsEnabled).toBe(true);
    expect(st.certDomains).toEqual(['your-machine.your-tailnet.ts.net']);
    expect(st.version).toBe('1.80.0-t123');
  });
  test('tolerates missing fields and reports NeedsLogin / NeedsMachineAuth', () => {
    const st = parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }))!;
    expect(st.backendState).toBe('NeedsLogin');
    expect(st.dnsName).toBeNull();
    expect(st.certDomains).toEqual([]);
    expect(st.magicDnsEnabled).toBeNull();
    expect(st.funnelCapable).toBeNull();
    expect(st.version).toBeNull();
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsMachineAuth' }))!.backendState).toBe('NeedsMachineAuth');
  });
  test('funnelCapable: CapMap key or Capabilities entry; null when both fields are absent', () => {
    expect(TAILSCALE_FUNNEL_CAPABILITY).toBe('https://tailscale.com/cap/funnel');
    const cap = (self: Record<string, unknown>) => parseTailscaleStatus(JSON.stringify({ ...STATUS_DOC, Self: { ...STATUS_DOC.Self, ...self } }))!.funnelCapable;
    expect(cap({})).toBeNull();
    expect(cap({ CapMap: { 'https://tailscale.com/cap/funnel': [], 'https://tailscale.com/cap/is-admin': [] } })).toBe(true);
    expect(cap({ CapMap: { 'https://tailscale.com/cap/is-admin': [] } })).toBe(false);
    expect(cap({ CapMap: {} })).toBe(false);
    expect(cap({ Capabilities: ['https://tailscale.com/cap/funnel'] })).toBe(true);
    expect(cap({ Capabilities: ['https://tailscale.com/cap/ssh'] })).toBe(false);
    expect(cap({ CapMap: {}, Capabilities: ['https://tailscale.com/cap/funnel'] })).toBe(true);
  });
  test('non-JSON / non-object output → null', () => {
    expect(parseTailscaleStatus('')).toBeNull();
    expect(parseTailscaleStatus('failed to connect to local Tailscale service')).toBeNull();
    expect(parseTailscaleStatus('[1,2]')).toBeNull();
  });
  test('publicUrlFromDnsName + normalizeDnsName', () => {
    expect(normalizeDnsName('Host.Tail.ts.net.')).toBe('host.tail.ts.net');
    expect(publicUrlFromDnsName('Host.Tail.ts.net.')).toBe('https://host.tail.ts.net');
  });
});

describe('findTailscaleBinary', () => {
  test('PATH lookup wins', () => {
    expect(findTailscaleBinary({ which: n => (n === 'tailscale' ? '/usr/bin/tailscale' : null), fileExists: () => true })).toBe('/usr/bin/tailscale');
  });
  test('falls back through the candidate list in order (macOS app bundle first)', () => {
    expect(TAILSCALE_BINARY_CANDIDATES[0]).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(findTailscaleBinary({ which: () => null, fileExists: p => p === '/opt/homebrew/bin/tailscale' })).toBe('/opt/homebrew/bin/tailscale');
  });
  test('nothing found → null', () => {
    expect(findTailscaleBinary({ which: () => null, fileExists: () => false })).toBeNull();
  });
  test('isSystemTailscaleBinary: a candidate path, or a path whose realpath is one, qualifies for sudo; anything else (or an unresolvable path) does not', () => {
    expect(isSystemTailscaleBinary('/usr/bin/tailscale', () => { throw new Error('must not be consulted for a literal candidate'); })).toBe(true);
    expect(isSystemTailscaleBinary('/usr/local/bin/ts-link', p => (p === '/usr/local/bin/ts-link' ? '/usr/bin/tailscale' : p))).toBe(true);
    expect(isSystemTailscaleBinary('/home/alice-example/.local/bin/tailscale', p => p)).toBe(false);
    expect(isSystemTailscaleBinary('/home/alice-example/.local/bin/tailscale', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })).toBe(false);
    // the default realpath never throws out of the helper for a missing file
    expect(isSystemTailscaleBinary('/nonexistent/definitely-not-tailscale')).toBe(false);
  });
});

describe('tailscaleInstallPlan', () => {
  test('macOS with brew → cask install', () => {
    const plan = tailscaleInstallPlan('darwin', true);
    expect(plan.kind).toBe('brew-cask');
    expect(plan.argv).toEqual(['brew', 'install', '--cask', 'tailscale-app']);
    expect(plan.note).toContain('open Tailscale and sign in');
  });
  test('linux → official installer through sh -c', () => {
    const plan = tailscaleInstallPlan('linux', false);
    expect(plan.kind).toBe('linux-script');
    expect(plan.argv).toEqual(['sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh']);
  });
  test('macOS without brew and other platforms → unsupported with the download URL', () => {
    for (const [platform, brew] of [['darwin', false], ['win32', true], ['freebsd', false]] as const) {
      const plan = tailscaleInstallPlan(platform, brew);
      expect(plan.kind).toBe('unsupported');
      expect(plan.argv).toBeNull();
      expect(plan.command).toBe(TAILSCALE_DOWNLOAD_URL);
    }
  });
});

describe('argv builders', () => {
  test('serve / funnel publish and off (scoped to the / mount with --set-path=/; never reset)', () => {
    expect(tailscaleServeArgv(3131)).toEqual(['serve', '--bg', '3131']);
    expect(tailscaleServeArgv(4000, { funnel: true })).toEqual(['funnel', '--bg', '4000']);
    // Without --set-path=/ the CLI removes EVERY mount under :443 and prompts when more than one exists.
    expect(tailscaleServeOffArgv()).toEqual(['serve', '--https=443', '--set-path=/', 'off']);
    expect(tailscaleServeOffArgv({ funnel: true })).toEqual(['funnel', '--https=443', '--set-path=/', 'off']);
    expect(tailscaleServeOffArgv().join(' ')).not.toContain('reset');
  });
  test('login: linux sets the operator first, then a FLAGLESS sudo up; macOS is a plain up', () => {
    expect(tailscaleLoginArgv('linux', 'alice-example')).toEqual({ setOperator: ['sudo', 'tailscale', 'set', '--operator=alice-example'], up: ['sudo', 'tailscale', 'up'] });
    const linux = tailscaleLoginArgv('linux', 'alice-example', '/usr/bin/tailscale');
    expect(linux.setOperator).toEqual(['sudo', '/usr/bin/tailscale', 'set', '--operator=alice-example']);
    expect(linux.up).toEqual(['sudo', '/usr/bin/tailscale', 'up']);
    expect(linux.up.join(' ')).not.toContain('--operator');
    const mac = tailscaleLoginArgv('darwin', 'alice-example', '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(mac.setOperator).toBeUndefined();
    expect(mac.up).toEqual(['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'up']);
    expect(tailscaleLoginArgv('linux', 'alice-example').up).toEqual(['sudo', 'tailscale', 'up']);
    // the copy-pasteable operator forms (owned here so the flag-registry scan of mcp-expose.ts never sees tailscale's flags)
    expect(tailscaleManualLoginCommand()).toBe('sudo tailscale set --operator=$USER && sudo tailscale up');
    // the manual login names the DISCOVERED binary (a ~/.local/bin install is outside sudo's secure_path, so a bare `sudo tailscale` would not find it), shell-quoted when needed
    expect(tailscaleManualLoginCommand('/home/alice-example/.local/bin/tailscale')).toBe('sudo /home/alice-example/.local/bin/tailscale set --operator=$USER && sudo /home/alice-example/.local/bin/tailscale up');
    expect(tailscaleManualLoginCommand('/Users/alice example/bin/tailscale')).toBe("sudo '/Users/alice example/bin/tailscale' set --operator=$USER && sudo '/Users/alice example/bin/tailscale' up");
    expect(TAILSCALE_ACCEPT_DNS_COMMAND).toBe('tailscale set --accept-dns=true');
  });
  test('CommandRunOptions carries the --json stdout redirect flag', () => {
    const opts: CommandRunOptions = { inherit: true, stdoutToStderr: true, timeoutMs: 10 };
    expect(opts.stdoutToStderr).toBe(true);
  });
});

describe('parseServeStatusStrict + handler lookup', () => {
  test('full ServeConfig → https443, one root handler proxying 3131 with funnel on', () => {
    const view = parseServeStatusStrict(JSON.stringify(SERVE_DOC))!;
    expect(view.https443).toBe(true);
    expect(view.handlers).toHaveLength(1);
    expect(view.handlers[0]).toMatchObject({ host: 'your-machine.your-tailnet.ts.net', port: 443, path: '/', proxy: 'http://127.0.0.1:3131', proxyPort: 3131, funnel: true, foreground: false, tcpForward: null });
    expect(view.funnelHosts).toEqual(['your-machine.your-tailnet.ts.net:443']);
    expect(findProxiedHandler(view, 3131)?.proxyPort).toBe(3131);
    expect(findProxiedHandler(view, 8080)).toBeNull();
    expect(findRootHandlers(view)).toHaveLength(1);
  });
  test('an empty document / {} / null / absent fields is the legitimately empty view, but non-JSON, an array or a scalar is null (fail closed)', () => {
    for (const raw of ['', '   \n', '{}', 'null', JSON.stringify({ Web: { 'h:443': {} } })]) {
      const view = parseServeStatusStrict(raw);
      expect(view).not.toBeNull();
      expect(view!.handlers).toEqual([]);
      expect(view!.https443).toBe(false);
      expect(findProxiedHandler(view!, 3131)).toBeNull();
    }
    for (const raw of ['not json', 'failed to connect to local Tailscale service; is Tailscale running?', '[1,2]', '"str"', '42', 'true', '{broken']) {
      expect(parseServeStatusStrict(raw)).toBeNull();
    }
  });
  test('a non-root or non-443 handler is not a root handler; funnel defaults off', () => {
    const view = parseServeStatusStrict(JSON.stringify({
      Web: {
        'h.ts.net:443': { Handlers: { '/api': { Proxy: 'http://127.0.0.1:9000' } } },
        'h.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:3131' } } },
      },
    }))!;
    expect(view.handlers).toHaveLength(2);
    expect(findRootHandlers(view)).toEqual([]);
    expect(findProxiedHandler(view, 3131)).toBeNull();
    expect(view.handlers.every(h => h.funnel === false)).toBe(true);
    expect(view.handlers.find(h => h.port === 8443)?.proxyPort).toBe(3131);
  });
  test('Foreground sessions fold in as foreground root handlers (another terminal owns them)', () => {
    const view = parseServeStatusStrict(JSON.stringify({
      ...SERVE_DOC,
      Foreground: {
        '1234567890': { TCP: { '443': { HTTPS: true } }, Web: { 'your-machine.your-tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } } } },
        'not-an-object': null,
      },
    }))!;
    expect(view.handlers).toHaveLength(2);
    const fg = view.handlers.find(h => h.proxyPort === 9000)!;
    // Same node, same host:443 — the root AllowFunnel entry applies to it too.
    expect(fg).toMatchObject({ foreground: true, port: 443, path: '/', funnel: true });
    expect(view.handlers.find(h => h.proxyPort === 3131)?.foreground).toBe(false);
    expect(findRootHandlers(view)).toHaveLength(2);
    expect(findProxiedHandler(view, 9000)?.foreground).toBe(true);
  });
  test("TCP['443'].TCPForward surfaces as a non-proxy root handler on :443", () => {
    const view = parseServeStatusStrict(JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:5432' } } }))!;
    expect(view.https443).toBe(false);
    expect(view.handlers).toHaveLength(1);
    expect(view.handlers[0]).toMatchObject({ port: 443, path: '/', proxy: null, proxyPort: null, tcpForward: '127.0.0.1:5432', foreground: false });
    expect(findRootHandlers(view)).toHaveLength(1);
    expect(findProxiedHandler(view, 5432)).toBeNull();
  });
});

describe('classifyTailscaleError', () => {
  test('https certificates disabled → https_not_enabled with the admin DNS URL', () => {
    const c = classifyTailscaleError('error: HTTPS is not enabled for this tailnet. Enable it at https://login.tailscale.com/admin/dns');
    expect(c.kind).toBe('https_not_enabled');
    expect(c.fix).toContain(TAILSCALE_ADMIN_DNS_URL);
    expect(classifyTailscaleError('HTTPS certificates are not enabled for this tailnet; enable them in the admin console').kind).toBe('https_not_enabled');
    expect(classifyTailscaleError('certificate issuance is disabled; enable HTTPS certs for the tailnet').kind).toBe('https_not_enabled');
  });
  test('a bare https:// URL next to "enable" does NOT trip the HTTPS rule', () => {
    expect(classifyTailscaleError('something failed; see https://login.tailscale.com/admin/dns to enable it').kind).toBe('unknown');
    expect(classifyTailscaleError('visit https://tailscale.com/kb/1223/funnel and enable it').kind).toBe('unknown');
  });
  test('funnel not enabled → funnel_not_enabled with the ACL admin URL and KB link (checked BEFORE the HTTPS rule)', () => {
    const c = classifyTailscaleError('Funnel not available; the `funnel` node attribute is not enabled by policy');
    expect(c.kind).toBe('funnel_not_enabled');
    expect(c.fix).toContain(TAILSCALE_ADMIN_ACL_URL);
    expect(c.fix).toContain(TAILSCALE_FUNNEL_KB_URL);
    // Mentions HTTPS certificates too — funnel still wins because it is matched first.
    expect(classifyTailscaleError('Funnel is not enabled by policy; HTTPS certificates are enabled at https://login.tailscale.com/admin/dns').kind).toBe('funnel_not_enabled');
  });
  test('operator / permission → needs_operator with the operator command on linux', () => {
    const c = classifyTailscaleError('Access denied: serve requires the operator flag or root', { platform: 'linux', user: 'alice-example' });
    expect(c.kind).toBe('needs_operator');
    expect(c.fix).toContain('sudo tailscale set --operator=alice-example');
    expect(classifyTailscaleError('PERMISSION DENIED', { platform: 'darwin' }).fix).toContain('Tailscale app');
  });
  test('logged out → needs_login (fix is the FLAGLESS up); daemon down → daemon_not_running (case-insensitive)', () => {
    const out = classifyTailscaleError('Tailscale is Logged Out.', { platform: 'linux', user: 'alice-example' });
    expect(out.kind).toBe('needs_login');
    expect(out.fix).toContain('sudo tailscale up');
    expect(out.fix).not.toContain('--operator');
    expect(classifyTailscaleError('state: NeedsLogin').kind).toBe('needs_login');
    const down = classifyTailscaleError('Failed to connect to local Tailscale service; is Tailscale running?', { platform: 'linux' });
    expect(down.kind).toBe('daemon_not_running');
    expect(down.fix).toContain('sudo systemctl enable --now tailscaled');
    expect(classifyTailscaleError('dial unix: connection refused', { platform: 'darwin' }).fix).toContain('open -a Tailscale');
  });
  test('anything else → unknown, carrying the raw stderr', () => {
    const c = classifyTailscaleError('  something odd happened  ');
    expect(c.kind).toBe('unknown');
    expect(c.raw).toBe('something odd happened');
    expect(c.fix).toContain('something odd happened');
    expect(classifyTailscaleError('').fix).toContain('without output');
  });
});

describe('defaultCommandRunner (real spawn, hermetic commands only)', () => {
  test('a child that ignores SIGTERM is SIGKILLed after the grace period: the runner returns (status null) instead of hanging', async () => {
    // `trap "" TERM` then `exec` keeps the ignored disposition across exec, so the
    // single `sleep` process survives the SIGTERM at 100ms and only the SIGKILL
    // escalation (3s later) ends it — well before the 30s it would otherwise run.
    const started = Date.now();
    const r = await defaultCommandRunner(['bash', '-c', 'trap "" TERM; exec sleep 30'], { timeoutMs: 100 });
    const elapsed = Date.now() - started;
    expect(r.status).toBeNull();
    expect(r.stderr).toContain('(timed out after 100ms)');
    expect(elapsed).toBeGreaterThanOrEqual(3_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
  test('pipes stdout/stderr with the exit status; a missing binary never throws; a timeout yields status null; inherit mode captures nothing', async () => {
    expect(await defaultCommandRunner(['sh', '-c', 'printf out; printf err >&2; exit 3'])).toEqual({ status: 3, stdout: 'out', stderr: 'err' });
    const missing = await defaultCommandRunner(['/nonexistent/definitely-not-tailscale', 'status', '--json']);
    expect(missing.status).toBeNull();
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toMatch(/ENOENT|no such file/i);
    const killed = await defaultCommandRunner(['sh', '-c', 'sleep 5'], { timeoutMs: 50 });
    expect(killed.status).toBeNull();
    expect(killed.stderr).toContain('(timed out after 50ms)');
    // inherit (login / installer): nothing is captured, the child's status still comes back
    expect(await defaultCommandRunner(['sh', '-c', 'exit 7'], { inherit: true, stdoutToStderr: true })).toEqual({ status: 7, stdout: '', stderr: '' });
  });
});

describe('parseServeStatusStrict edges', () => {
  test('proxy ports: scheme defaults when no port is given, out-of-range → null, a path suffix is ignored, non-proxy handlers carry null', () => {
    const view = parseServeStatusStrict(JSON.stringify({
      Web: {
        'a.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost' } } },
        'b.ts.net:443': { Handlers: { '/': { Proxy: 'https://svc.internal' } } },
        'c.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:99999' } } },
        'd.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3131/base' } } },
        'e.ts.net:443': { Handlers: { '/': { Path: '/var/www' } } },
      },
    }))!;
    const byHost = Object.fromEntries(view.handlers.map(h => [h.host, h]));
    expect(byHost['a.ts.net'].proxyPort).toBe(80);
    expect(byHost['b.ts.net'].proxyPort).toBe(443);
    expect(byHost['c.ts.net'].proxyPort).toBeNull();
    expect(byHost['d.ts.net'].proxyPort).toBe(3131);
    expect(byHost['e.ts.net']).toMatchObject({ proxy: null, proxyPort: null, tcpForward: null });
    expect(findProxiedHandler(view, 3131)?.host).toBe('d.ts.net');
    expect(findRootHandlers(view)).toHaveLength(5);
  });
  test('Web keys without a port or with a non-numeric port default to 443; AllowFunnel false is not funnel; a Foreground block brings its own AllowFunnel and HTTPS flag', () => {
    const view = parseServeStatusStrict(JSON.stringify({
      Web: {
        'bare.ts.net': { Handlers: { '/': { Proxy: 'http://127.0.0.1:1' } } },
        'odd.ts.net:abc': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2' } } },
      },
      AllowFunnel: { 'bare.ts.net': false, 'odd.ts.net:abc': true },
      Foreground: {
        '7': { TCP: { '443': { HTTPS: true } }, Web: { 'fg.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5000' } } } }, AllowFunnel: { 'FG.ts.net:443': true } },
      },
    }))!;
    expect(view.https443).toBe(true); // only the foreground block carries TCP 443 HTTPS
    expect(view.funnelHosts).toEqual(['odd.ts.net:abc']); // root list stays root-only (false filtered)
    const bare = view.handlers.find(h => h.host === 'bare.ts.net')!;
    expect(bare).toMatchObject({ port: 443, funnel: false, foreground: false });
    const odd = view.handlers.find(h => h.host === 'odd.ts.net')!;
    expect(odd).toMatchObject({ port: 443, funnel: true, foreground: false });
    const fg = view.handlers.find(h => h.host === 'fg.ts.net')!;
    expect(fg).toMatchObject({ port: 443, funnel: true, foreground: true, proxyPort: 5000 });
    expect(findRootHandlers(view)).toHaveLength(3);
  });
});

describe('parseTailscaleStatus tolerance + classifier defaults', () => {
  test('non-object Self/CurrentTailnet, mixed-type arrays and non-string scalars degrade to safe defaults', () => {
    const st = parseTailscaleStatus(JSON.stringify({ BackendState: 7, Self: 'nope', CurrentTailnet: [1], CertDomains: ['a.ts.net', 3, null], Version: 12 }))!;
    expect(st).toEqual({ backendState: 'NoState', dnsName: null, tailscaleIps: [], magicDnsEnabled: null, certDomains: ['a.ts.net'], funnelCapable: null, version: null });
    const ips = parseTailscaleStatus(JSON.stringify({ Self: { TailscaleIPs: ['100.64.0.1', 5, null, 'fd7a::1'], CapMap: [] }, CurrentTailnet: { MagicDNSEnabled: 'yes' } }))!;
    expect(ips.tailscaleIps).toEqual(['100.64.0.1', 'fd7a::1']);
    expect(ips.funnelCapable).toBeNull(); // an array-shaped CapMap is not a capability map
    expect(ips.magicDnsEnabled).toBeNull();
  });
  test('classifyTailscaleError without a user falls back to $USER in the operator remedy and to the flagless up for login', () => {
    expect(classifyTailscaleError('access denied', { platform: 'linux' }).fix).toContain('sudo tailscale set --operator=$USER');
    expect(classifyTailscaleError('Logged out', { platform: 'linux' }).fix).toContain('`sudo tailscale up`');
    expect(classifyTailscaleError('not logged in', { platform: 'darwin' }).fix).toContain('`tailscale up`');
  });
});
