/**
 * `gbrain google mint serve|status`, `gbrain google approvals [answer]` and
 * `gbrain google exec`: the local Google token socket (docs/guides/google-socket.md).
 */
import { agentBlock } from '../core/agent-markers.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { appendAuditLine } from '../core/google-socket/ledger.ts';
import { spawn } from '../core/spawn.ts';
import net from 'node:net';
import { configDir } from '../core/config.ts';
import { readGoogleSocketConfig } from '../core/google-socket/config.ts';
import { brokerGate } from '../core/google-socket/preconditions.ts';
import { GOOGLE_SOCKET_VERSION, SocketError } from '../core/google-socket/protocol.ts';
import { googleAuditPath, googleSocketPath, startGoogleSocket } from '../core/google-socket/server.ts';
import { SocketTokens } from '../core/google-socket/tokens.ts';
import { openVault } from '../core/creds/vault.ts';

/** One request, one reply, over the socket; `mint_socket_down` when nothing answers. */
export function socketRequest(path: string, request: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const closed = () => Object.assign(new Error('peer_refused: the Google socket closed the connection without answering; this uid may not be in google.socket_peers (gbrain google mint status)'), { code: 'peer_refused' });
    const socket = net.createConnection(path);
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the Google socket did not answer in time')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ v: GOOGLE_SOCKET_VERSION, ...request }) + '\n'));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>); } catch { reject(new Error('the Google socket answered with a line that is not JSON')); }
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? Object.assign(new Error(`mint_socket_down: nothing serves ${path}; start it with gbrain google mint serve (or gbrain serve --http with google.mint_socket true)`), { code: 'mint_socket_down' })
        : error.code === 'EACCES'
          ? Object.assign(new Error(`peer_refused: this uid cannot open ${path}; the socket is 0600 and this release serves only its owner and root`), { code: 'peer_refused' })
          : error.code === 'EPIPE' || error.code === 'ECONNRESET' ? closed() : error);
    });
    socket.once('close', () => { clearTimeout(timer); reject(closed()); });
  });
}

async function mintServe(): Promise<void> {
  const started = await startGoogleSocket({ log: line => console.error(`[gbrain] ${line}`), config: readGoogleSocketConfig });
  if (!started.ok) process.exit(1);
  const stop = () => { started.binding.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<never>(() => {});
}

function mintStatus(json: boolean): void {
  const cfg = readGoogleSocketConfig();
  const uid = process.getuid?.() ?? -1;
  const gate = brokerGate(cfg, uid, configDir());
  const peers = cfg.socket_peers ?? [];
  const unreachable = peers.filter(p => p !== uid && p !== 0);
  const out = { path: googleSocketPath(), protocol: GOOGLE_SOCKET_VERSION, mint_socket_in_serve: cfg.mint_socket === true, peers, unreachable_peers: unreachable,
    broker: { call: gate.ok ? 'on' : 'off', root_gateway_opt_in: gate.rootGateway, unmet: gate.unmet } };
  if (json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Google socket: ${out.path} (protocol v${out.protocol})`);
  console.log(`  started by gbrain serve --http: ${out.mint_socket_in_serve ? 'yes' : 'no (gbrain google mint serve, or google.mint_socket true)'}`);
  console.log(`  peers: owner uid ${uid}${out.peers.length ? ` + ${out.peers.join(', ')}` : ''}`);
  if (unreachable.length) console.log(`    note: uid ${unreachable.join(', ')} cannot open this 0600 socket; this release serves the owner and root only (a group socket for non-root agent uids comes later)`);
  console.log(`  write broker (call): ${out.broker.call}${gate.rootGateway ? ' (root-gateway opt-in)' : ''}`);
  for (const line of gate.unmet) console.log(`    unmet: ${line}`);
}

export async function runGoogleMint(args: string[]): Promise<void> {
  const [sub] = args;
  if (sub === 'serve') return mintServe();
  if (sub === 'status') return mintStatus(args.includes('--json'));
  console.error('Usage: gbrain google mint serve | gbrain google mint status [--json]');
  process.exit(2);
}

export async function runGoogleApprovals(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const path = googleSocketPath();
  if (args[0] === 'answer') {
    const [, requestId, choice] = args;
    if (!requestId || !choice) { console.error('Usage: gbrain google approvals answer <request_id> <choice>'); process.exit(2); }
    if (!process.stdin.isTTY) {
      console.error('[gbrain] approvals are answered only by the account owner at a terminal; nothing was sent.');
      process.stderr.write(agentBlock({ ask: 'the account owner answers the held prompt', actor: 'user', next: 'gbrain google approvals' }, { showUser: 'Run gbrain google approvals in a terminal and answer the held prompt there.' }));
      setCliExitVerdict(2);
      return;
    }
    const reply = await socketRequest(path, { op: 'verdict', request_id: requestId, choice });
    console.log(json ? JSON.stringify(reply, null, 2) : reply.ok ? `Answered ${requestId}: ${choice}` : `${reply.code}: ${reply.message}`);
    if (!reply.ok) process.exit(1);
    return;
  }
  const reply = await socketRequest(path, { op: 'pending' });
  if (json) { console.log(JSON.stringify(reply, null, 2)); return; }
  if (!reply.ok) { console.error(`${reply.code}: ${reply.message}`); process.exit(1); }
  const pending = reply.pending as Array<Record<string, unknown>>;
  if (pending.length === 0) { console.log('Nothing is waiting for an answer.'); return; }
  for (const p of pending) console.log(formatPending(p).join('\n'));
  console.log('Answer one: gbrain google approvals answer <request_id> <choice>');
}

const ARGS_SHOWN = 600;

/** One held call as the owner reads it: the outside invitees first, then the arguments, with any cut marked. */
export function formatPending(p: Record<string, unknown>): string[] {
  const outside = (p.outside as string[] | undefined) ?? [];
  const args = JSON.stringify(p.args ?? {});
  return [
    `${p.request_id}  ${p.account}  ${p.server}.${p.tool}  turn ${p.turn_id}  expires ${p.expires_at}`,
    p.kind === 'owner_confirm' ? '  safety pause: confirm with ALLOW_ONCE' : `  Google asks: ${String(p.message_md).replace(/\n/g, '\n    ')}`,
    ...(outside.length ? [`  outside invitees: ${outside.join(', ')}`] : []),
    `  arguments: ${args.length > ARGS_SHOWN ? `${args.slice(0, ARGS_SHOWN)}… (${args.length - ARGS_SHOWN} more characters; --json shows all)` : args}`,
    `  choices: ${(p.choices as string[]).join(', ')}`,
  ];
}

const REDACTED = '[redacted:google_token]';
const DEBUG_FLAG = /^--?(debug|verbose|v{1,3}|trace|log[-_]?level|dump[-_\w]*|http[-_]?log)(=.*)?$/i;

/** Streams text with every copy of the token replaced, holding back a tail that could start a split copy. */
export class TokenRedactor {
  private carry = '';
  constructor(private readonly token: string) {}
  push(chunk: string): string {
    const text = (this.carry + chunk).split(this.token).join(REDACTED);
    const keep = Math.min(text.length, this.token.length - 1);
    this.carry = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }
  flush(): string { const rest = this.carry.split(this.token).join(REDACTED); this.carry = ''; return rest; }
}

export async function runGoogleExec(args: string[]): Promise<void> {
  const dash = args.indexOf('--');
  const head = dash >= 0 ? args.slice(0, dash) : args;
  const child = dash >= 0 ? args.slice(dash + 1) : [];
  const ai = head.indexOf('--account');
  const account = ai >= 0 ? head[ai + 1]?.toLowerCase() : undefined;
  const refuse = (msg: string): never => { console.error(`[gbrain] google exec: ${msg}; nothing was run.`); process.exit(2); };
  if (!account || child.length === 0) refuse('usage: gbrain google exec --account <email> -- gwscli <args...>');
  if (child[0] !== 'gwscli') refuse('only gwscli, by its bare name on PATH, is run with a minted token');
  const bad = child.slice(1).find(a => DEBUG_FLAG.test(a) || /^--?oauth[-_]token/i.test(a));
  if (bad) refuse(`${bad} is refused (debug output can print the token; the token is supplied by gbrain)`);
  let token: string;
  try {
    token = (await new SocketTokens(openVault()).mintIngest(account!)).access_token;
    appendAuditLine(googleAuditPath(), ['gwscli-exec', account!, 'ingest', 'ok']);
  } catch (error) {
    const e = error as SocketError;
    appendAuditLine(googleAuditPath(), ['gwscli-exec', account!, 'ingest', e.code ?? 'internal']);
    console.error(`[gbrain] google exec: ${e.code ?? 'internal'}: ${e.message}`);
    process.exit(1);
  }
  const redact = { out: new TokenRedactor(token), err: new TokenRedactor(token) };
  const proc = spawn(child[0]!, [`--oauth_token=${token}`, ...child.slice(1)], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, GWSCLI_TELEMETRY_ENABLED: '0' },
  });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => process.stdout.write(redact.out.push(c)));
  proc.stderr.on('data', (c: string) => process.stderr.write(redact.err.push(c)));
  const code = await new Promise<number>(resolve => {
    proc.once('error', error => { process.stderr.write(`[gbrain] google exec: ${error.message.split(token).join(REDACTED)}\n`); resolve(127); });
    proc.once('close', status => resolve(status ?? 1));
  });
  process.stdout.write(redact.out.flush());
  process.stderr.write(redact.err.flush());
  setCliExitVerdict(code);
}
