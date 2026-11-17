/**
 * GST-2961 test fixture: a local Git smart-HTTP server whose push answers are chosen by the first path segment.
 * Reads (upload-pack) go to git http-backend without auth, except under /notfound/, where every request needs a
 * credential and then answers 404 "Repository not found", like a host to an account that cannot see the repository.
 *   /notfound/<repo>   push: 401 until a credential is sent, then 404 "Repository not found."
 *   /forbidden/<repo>  push: 401 until a credential is sent, then 403 "Permission to ... denied"
 *   /drop/<repo>       push: 502, as a dropped connection or a failing proxy
 *   /ok/<repo>         push: git http-backend (the push lands)
 * GET /__count/<mode> returns how many receive-pack requests that mode got. Prints its port on stdout.
 * Usage: bun server.ts <project-root>
 */
const project = process.argv[2] ?? '';
const counts: Record<string, number> = {};

function backend(req: Request, path: string, body: Uint8Array): Response {
  const url = new URL(req.url);
  const run = Bun.spawnSync(['git', 'http-backend'], { stdin: body, env: { ...process.env, GIT_PROJECT_ROOT: project, GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: path, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get('content-type') ?? '',
    CONTENT_LENGTH: String(body.length), REMOTE_USER: 'stub' } });
  const out = Buffer.from(run.stdout);
  const split = out.indexOf('\r\n\r\n');
  const headers = new Headers();
  let status = 200;
  for (const line of out.subarray(0, split).toString().split('\r\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i), value = line.slice(i + 1).trim();
    if (key.toLowerCase() === 'status') status = parseInt(value, 10); else headers.set(key, value);
  }
  return new Response(out.subarray(split + 4), { status, headers });
}

const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
  const url = new URL(req.url);
  const [, mode = '', ...rest] = url.pathname.split('/');
  if (mode === '__count') return new Response(String(counts[rest[0] ?? ''] ?? 0));
  const path = '/' + rest.join('/');
  const receive = path.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';
  if (receive) counts[mode] = (counts[mode] ?? 0) + 1;
  const body = new Uint8Array(await req.arrayBuffer());
  if (mode === 'notfound' || (receive && mode === 'forbidden')) {
    if (!req.headers.get('authorization')) return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="stub"' } });
    return mode === 'notfound'
      ? new Response('Repository not found.\n', { status: 404, headers: { 'content-type': 'text/plain' } })
      : new Response('Permission to acme-example/brain.git denied to user-b.\n', { status: 403, headers: { 'content-type': 'text/plain' } });
  }
  if (receive && mode === 'drop') return new Response(null, { status: 502 });
  return backend(req, path, body);
} });
console.log(server.port);
