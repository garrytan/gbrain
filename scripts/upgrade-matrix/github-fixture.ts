/**
 * Upgrade matrix (GBRA-224 W2): the GitHub an old release's updater sees.
 *
 * An installed release reaches GitHub four ways: Bun fetches the package
 * tarball from the API (GITHUB_API_URL, else https://api.github.com), gbrain
 * reads files from raw.githubusercontent.com (VERSION, the target's
 * package.json for the Bun floor, CHANGELOG), git ls-remote lists release
 * tags on https://github.com/garrytan/gbrain, and the binary updater reads
 * release metadata from the API. Every one of them is interposed here, so the
 * updater can only see the refs this fixture names:
 *
 * - git: url.<bare mirror>.insteadOf https://github.com/garrytan/gbrain in
 *   the cell's own global git config; the mirror holds exactly the fixture's
 *   refs (refs/heads/master, refs/tags/<name>).
 * - HTTP(S): an HTTPS_PROXY that tunnels the GitHub hosts to a local TLS
 *   server whose certificate a per-run CA signs (trusted through
 *   NODE_EXTRA_CA_CERTS), tunnels only the allowlisted hosts (the npm
 *   registry) to the internet, and refuses every other host. Bun's tarball
 *   API is also pointed at the plain-HTTP side with GITHUB_API_URL.
 *
 * - Embedding providers: a host in FORWARDABLE_HOSTS that a cell maps in
 *   `forward` is terminated by the same TLS server and relayed to a local
 *   fake provider, so a keyed brain keeps the provider's real URL and nothing
 *   is billed. Unmapped, it is refused like any other host.
 *
 * Every request is logged with the commit it was answered from, so a cell can
 * assert the upgrade saw no commit other than the candidate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

export const REPO = 'garrytan/gbrain';
export const GITHUB_HOSTS = ['api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'] as const;
export const DEFAULT_ALLOW_HOSTS = ['registry.npmjs.org'];
export const FORWARDABLE_HOSTS = ['api.voyageai.com'] as const;

export interface FixtureRequest { host: string; method: string; path: string; status: number; sha?: string }
export interface ProxyDecision { host: string; port: number; action: 'fixture' | 'tunnel' | 'denied' }

export interface FixtureHandle {
  /** GITHUB_API_URL for Bun's tarball fetches (plain HTTP, loopback). */
  apiUrl: string;
  /** HTTPS_PROXY for every cell process. */
  proxyUrl: string;
  caFile: string;
  mirror: string;
  requests: FixtureRequest[];
  proxy: ProxyDecision[];
  /** Point the named refs (HEAD/master, latest-stable, stable, v<x>) at commits; every other ref disappears. */
  setRefs(refs: Record<string, string>): void;
  refs(): Record<string, string>;
  stop(): void;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/** A bare repository borrowing source's objects, holding no refs until setRefs. */
export function createMirror(source: string, dir: string): string {
  if (!existsSync(join(dir, 'HEAD'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '--bare', '--quiet', dir]);
    const common = git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    writeFileSync(join(dir, 'objects', 'info', 'alternates'), join(common, 'objects') + '\n');
  }
  return dir;
}

/** Per-run CA and a leaf certificate for the GitHub hosts (openssl, valid 2 days). */
export function createCertificates(dir: string): { ca: string; cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const ca = join(dir, 'ca.pem'), caKey = join(dir, 'ca.key'), key = join(dir, 'leaf.key'), csr = join(dir, 'leaf.csr'), cert = join(dir, 'leaf.pem'), ext = join(dir, 'leaf.ext');
  if (existsSync(cert)) return { ca, cert, key };
  const ssl = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '2', '-subj', '/CN=gbrain upgrade matrix fixture CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=github fixture']);
  writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + [...GITHUB_HOSTS, ...FORWARDABLE_HOSTS].map(h => 'DNS:' + h).join(',') + '\n');
  ssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '2', '-extfile', ext]);
  return { ca, cert, key };
}

function refName(ref: string): string {
  return ref === 'HEAD' || ref === 'master' ? 'refs/heads/master' : 'refs/tags/' + ref;
}

/** The ref and file a fixture-served request names, or null when the fixture does not serve it. */
export function parseFixturePath(host: string, path: string): { kind: 'tarball' | 'raw' | 'api'; ref: string; file?: string } | null {
  const p = decodeURIComponent(path.split('?')[0]!);
  const repo = '/repos/' + REPO + '/';
  if ((host === 'api.github.com' || host === 'loopback') && p.startsWith(repo)) {
    const rest = p.slice(repo.length);
    const tar = /^tarball(?:\/(.*))?$/.exec(rest);
    if (tar) return { kind: 'tarball', ref: tar[1] || 'HEAD' };
    return { kind: 'api', ref: rest };
  }
  if (host === 'codeload.github.com' && p.startsWith('/' + REPO + '/tar.gz/')) return { kind: 'tarball', ref: p.slice(REPO.length + 9) || 'HEAD' };
  if (host === 'raw.githubusercontent.com' && p.startsWith('/' + REPO + '/')) {
    const rest = p.slice(REPO.length + 2).replace(/^refs\/(heads|tags)\//, '');
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    return { kind: 'raw', ref: rest.slice(0, slash), file: rest.slice(slash + 1) };
  }
  return null;
}

export interface FixtureOptions {
  /** Checkout whose objects the mirror borrows. */
  source: string;
  mirrorDir: string;
  /** Shared across cells: git archives by commit. */
  archiveDir: string;
  /** Shared across cells: the run's CA and leaf certificate. */
  certDir: string;
  /** FORWARDABLE_HOSTS entries relayed to a local base URL. */
  forward?: Record<string, string>;
  allowHosts?: string[];
}

export async function startGithubFixture(opts: FixtureOptions): Promise<FixtureHandle> {
  const mirror = createMirror(opts.source, opts.mirrorDir);
  const archives = opts.archiveDir;
  mkdirSync(archives, { recursive: true });
  const certs = createCertificates(opts.certDir);
  const allow = new Set(opts.allowHosts ?? DEFAULT_ALLOW_HOSTS);
  const forward = new Map(Object.entries(opts.forward ?? {}).filter(([h]) => (FORWARDABLE_HOSTS as readonly string[]).includes(h)));
  const requests: FixtureRequest[] = [];
  const proxyLog: ProxyDecision[] = [];
  let current: Record<string, string> = {};

  const resolveRef = (ref: string): string | undefined => current[ref || 'HEAD'] ?? (/^[0-9a-f]{40}$/.test(ref) && Object.values(current).includes(ref) ? ref : undefined);

  const tarball = (sha: string): string => {
    const file = join(archives, sha + '.tar.gz');
    if (!existsSync(file)) {
      const tmp = file + '.' + process.pid + '.tmp';
      execFileSync('git', ['-C', mirror, 'archive', '--format=tar.gz', '--prefix=garrytan-gbrain-' + sha.slice(0, 7) + '/', '-o', tmp, sha]);
      renameSync(tmp, file);
    }
    return file;
  };

  const handle = async (host: string, req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const target = forward.get(host);
    if (target) {
      const res = await fetch(target.replace(/\/$/, '') + url.pathname + url.search, {
        method: req.method, headers: { 'content-type': req.headers.get('content-type') ?? 'application/json', authorization: req.headers.get('authorization') ?? '' },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      });
      requests.push({ host, method: req.method, path: url.pathname, status: res.status });
      return new Response(await res.arrayBuffer(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
    }
    const parsed = parseFixturePath(host, url.pathname);
    const record = (status: number, sha?: string) => { requests.push({ host, method: req.method, path: url.pathname, status, ...(sha ? { sha } : {}) }); };
    const sha = parsed ? resolveRef(parsed.ref) : undefined;
    if (!parsed || !sha || parsed.kind === 'api') { record(404, sha); return new Response('404: Not Found', { status: 404 }); }
    if (parsed.kind === 'tarball') {
      record(200, sha);
      return new Response(Bun.file(tarball(sha)), { headers: { 'content-type': 'application/x-gzip' } });
    }
    const show = spawnSync('git', ['-C', mirror, 'show', sha + ':' + parsed.file], { maxBuffer: 64 * 1024 * 1024 });
    if (show.status !== 0) { record(404, sha); return new Response('404: Not Found', { status: 404 }); }
    record(200, sha);
    return new Response(show.stdout);
  };

  const plain = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => handle('loopback', req) });
  const tls = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    tls: { cert: readFileSync(certs.cert, 'utf8'), key: readFileSync(certs.key, 'utf8') },
    fetch: req => handle((req.headers.get('host') ?? '').split(':')[0]!.toLowerCase(), req),
  });

  const proxy: Server = createServer((client: Socket) => {
    client.on('error', () => client.destroy());
    client.once('data', (head: Buffer) => {
      const line = head.toString('latin1').split('\r\n')[0] ?? '';
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]$/i.exec(line);
      const deny = (host: string, port: number) => { proxyLog.push({ host, port, action: 'denied' }); client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'); };
      if (!m) return deny(/^\w+ https?:\/\/([^/:\s]+)/i.exec(line)?.[1] ?? 'unknown', 80);
      const host = m[1]!.toLowerCase(), port = Number(m[2]);
      const fixture = (GITHUB_HOSTS as readonly string[]).includes(host) || forward.has(host);
      if (!fixture && !allow.has(host)) return deny(host, port);
      proxyLog.push({ host, port, action: fixture ? 'fixture' : 'tunnel' });
      const upstream = fixture ? connect(tls.port!, '127.0.0.1') : connect(port, host);
      upstream.on('error', () => { client.destroy(); upstream.destroy(); });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(head.indexOf('\r\n\r\n') + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
    });
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()));
  const proxyPort = (proxy.address() as { port: number }).port;

  return {
    apiUrl: 'http://127.0.0.1:' + plain.port,
    proxyUrl: 'http://127.0.0.1:' + proxyPort,
    caFile: certs.ca,
    mirror,
    requests,
    proxy: proxyLog,
    setRefs(refs) {
      const next: Record<string, string> = { ...refs };
      if (next.master && !next.HEAD) next.HEAD = next.master;
      if (next.HEAD && !next.master) next.master = next.HEAD;
      const wanted = new Map(Object.entries(next).filter(([ref]) => ref !== 'HEAD').map(([ref, sha]) => [refName(ref), sha]));
      const lines = git(mirror, ['for-each-ref', '--format=%(refname)']).split('\n').filter(r => r && !wanted.has(r)).map(r => 'delete ' + r);
      for (const [ref, sha] of wanted) lines.push('update ' + ref + ' ' + sha);
      git(mirror, ['update-ref', '--stdin'], lines.join('\n') + '\n');
      current = next;
    },
    refs: () => ({ ...current }),
    stop() { plain.stop(true); tls.stop(true); proxy.close(); },
  };
}
