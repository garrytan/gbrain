/**
 * A hermetic GBrain Helper Contacts route for tests (plan GST-3256, route contract with ALPH-138, 11-20): a local HTTP
 * server on 127.0.0.1 serving `GET /v1/contacts/changes?cursor=&limit=` from an in-memory Contacts store with a change
 * history, in the route's wire format (gbrain#9850: `{data, meta: {next_cursor, more, full}}`, every scalar a string, Problem
 * bodies with a `code`), plus a minimal SOCKS5 proxy (no authentication, CONNECT only) for the proxy path. Synthetic contacts only.
 *
 * Cursors: a snapshot page cursor is `snap:<offset>:<seq>` (the snapshot frozen at history seq), and the change
 * cursor the last snapshot page (or any change page) hands out is `seq:<n>`. `expire()` makes every cursor older
 * than now answer 410 cursor_expired. `queue` returns canned responses first (503, 403 contacts_not_allowed, ...).
 */
import { createServer as createTcpServer, connect, type Server as TcpServer, type Socket } from 'node:net';

export interface StubContact {
  given_name?: string; family_name?: string; nickname?: string; organization?: string; job_title?: string;
  emails?: Array<{ label: string | null; value: string }>; phones?: Array<{ label: string | null; value: string }>; groups?: string[];
}

export const STUB_TOKEN = 'stub-read-contacts-token-0123456789';

export class ContactsStub {
  contacts = new Map<string, StubContact>();
  history: Array<{ seq: number; id: string }> = [];
  seq = 0;
  expiredBefore = 0;
  /** Canned responses, one per request, before the store answers; a null entry lets that request through. */
  queue: Array<{ status: number; body?: unknown } | null> = [];
  /** The most contacts or changes one page carries, whatever the client asks for. */
  pageSize = 500;
  /** The last snapshot page says full:true (false: an incomplete snapshot). */
  full = true;
  requests: Array<{ path: string; authorization: string | null }> = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  upsert(id: string, contact: StubContact): void { this.contacts.set(id, contact); this.history.push({ seq: ++this.seq, id }); }
  remove(id: string): void { this.contacts.delete(id); this.history.push({ seq: ++this.seq, id }); }
  /** Forget the history so far: every cursor issued until now is expired (410). */
  expire(): void { this.expiredBefore = ++this.seq; }

  get port(): number { return this.server!.port!; }

  start(): this {
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => this.answer(req) });
    return this;
  }
  stop(): void { this.server?.stop(true); this.server = null; }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private item(id: string): Record<string, unknown> {
    const contact = this.contacts.get(id);
    return contact ? { op: 'upsert', id, contact: { given_name: '', family_name: '', nickname: '', organization: '', job_title: '', emails: [], phones: [], groups: [], ...contact } } : { op: 'delete', id };
  }

  answer(req: Request): Response {
    const url = new URL(req.url);
    this.requests.push({ path: url.pathname + url.search, authorization: req.headers.get('authorization') });
    const canned = this.queue.shift();
    if (canned) return this.json(canned.body ?? {}, canned.status);
    if (url.pathname !== '/v1/contacts/changes') return this.json({ code: 'not_found' }, 404);
    if (req.headers.get('authorization') !== `Bearer ${STUB_TOKEN}`) return this.json({ code: 'unauthorized' }, 401);
    const limit = Math.min(this.pageSize, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
    const cursor = url.searchParams.get('cursor');
    if (!cursor || cursor.startsWith('snap:')) {
      const [, offsetText, seqText] = (cursor ?? `snap:0:${this.seq}`).split(':');
      const offset = Number(offsetText), at = Number(seqText);
      if (at < this.expiredBefore) return this.json({ code: 'cursor_expired' }, 410);
      const ids = [...this.contacts.keys()].sort();
      const slice = ids.slice(offset, offset + limit);
      const more = offset + limit < ids.length;
      return this.json({ data: slice.map(id => this.item(id)), meta: { next_cursor: more ? `snap:${offset + limit}:${at}` : `seq:${at}`, more, full: !more && this.full } });
    }
    const after = Number(cursor.replace(/^seq:/, ''));
    if (!Number.isSafeInteger(after) || after < this.expiredBefore) return this.json({ code: 'cursor_expired' }, 410);
    const entries = this.history.filter(h => h.seq > after).slice(0, limit);
    const more = this.history.filter(h => h.seq > after).length > entries.length;
    const last = entries.at(-1)?.seq ?? after;
    const ids = [...new Set(entries.map(e => e.id))];
    return this.json({ data: ids.map(id => this.item(id)), meta: { next_cursor: `seq:${last}`, more, full: false } });
  }
}

/** A SOCKS5 proxy (no authentication, CONNECT only) that records the host names it was asked to resolve. */
export class Socks5Stub {
  asked: Array<{ host: string; port: number }> = [];
  /** Host names the proxy resolves (socks5h): name → address. */
  names = new Map<string, string>();
  private server: TcpServer | null = null;
  get port(): number { return (this.server!.address() as { port: number }).port; }

  start(): Promise<this> {
    this.server = createTcpServer(socket => this.serve(socket));
    return new Promise(resolve => this.server!.listen(0, '127.0.0.1', () => resolve(this)));
  }
  stop(): Promise<void> { return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }

  private serve(client: Socket): void {
    let buffer = Buffer.alloc(0);
    let stage: 'greet' | 'request' | 'piped' = 'greet';
    client.on('error', () => {});
    client.on('data', chunk => {
      if (stage === 'piped') return;
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (stage === 'greet') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        client.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        const atyp = buffer[3]!;
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4]!;
        if (buffer.length < 4 + len + 2) return;
        const host = atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : atyp === 3 ? buffer.subarray(5, 5 + buffer[4]!).toString('utf8') : '::1';
        const port = buffer.readUInt16BE(4 + len);
        const rest = buffer.subarray(4 + len + 2);
        this.asked.push({ host, port });
        const target = this.names.get(host) ?? host;
        const upstream = connect({ host: target, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          stage = 'piped';
          if (rest.length) upstream.write(new Uint8Array(rest));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
      }
    });
  }
}
