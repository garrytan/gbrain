/**
 * `gbrain wakeshift enable | disable | status | test` (plan D4, PR 1): the
 * trusted local switch for reporting back through Wakeshift. Only this
 * command writes `wakeshift.enabled` (host file plane), so no MCP or HTTP
 * caller can turn it on. `enable` asks consent (egress, credentials), refuses
 * a brain with live access members, checks the key with GET /app and merges
 * the event manifest; `disable` hides the watch tools at once and ends open
 * watches; `status` and `test` show the key's kid fingerprint, never the key.
 * Guide: docs/guides/wakeshift.md.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { requireConsent } from '../core/consent.ts';
import { WakeshiftError, WakeshiftKeyError, normalizeWakeshiftUrl, parseWakeshiftKey, wakeshiftClient, type WakeshiftKey } from '../core/wakeshift/client.ts';
import { readWakeshiftKey, wakeshiftFileConfig, wakeshiftKeyFile, wakeshiftPublished, wakeshiftSecret } from '../core/wakeshift/config.ts';
import { wakeshiftManifest } from '../core/wakeshift/events.ts';
import { endAtWakeshift, liveAccessMembers } from '../core/wakeshift/drain.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const HELP = `gbrain wakeshift <command> — report back to agent conversations when jobs finish (off by default)

Commands:
  status [--json]            on/off, where the key comes from (its kid fingerprint only) and watch counts
  enable [--key-stdin] [--url <https url>] [--yes]
                             turn reporting back on: asks consent, checks the key with Wakeshift and
                             publishes gbrain's event; --key-stdin saves the key from stdin to
                             ~/.gbrain/wakeshift.key (0600)
  disable [--json]           turn it off: the watch tools disappear at once and open watches end
  test [--json]              check the key and the app with Wakeshift; sends no wake

The key is read from WAKESHIFT_API_KEY (e.g. in ~/.gbrain/.env) or ~/.gbrain/wakeshift.key.
gbrain never creates a Wakeshift account or key. Guide: docs/guides/wakeshift.md`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : undefined;
}

const KEY_HINT = 'Create a key in your Wakeshift console and put it in ~/.gbrain/wakeshift.key (chmod 600) or WAKESHIFT_API_KEY in ~/.gbrain/.env, then run gbrain wakeshift enable again.';

function keyError(reason: string, message: string, suggestion: string): Error {
  return opError('wakeshift_key_invalid', message, suggestion, { reason });
}

/** The configured key, parsed, or a wakeshift_key_invalid error that names what to do. */
function loadKey(): { key: WakeshiftKey; source: 'env' | 'file' } {
  const read = readWakeshiftKey();
  if (read.source === 'file_too_open') {
    throw keyError('file_too_open', `${wakeshiftKeyFile()} is readable by other users (mode ${read.mode}).`, `Run chmod 600 ${wakeshiftKeyFile()}, then run gbrain wakeshift enable again.`);
  }
  if (read.source === 'none') throw keyError('missing', 'No Wakeshift key: set WAKESHIFT_API_KEY (in ~/.gbrain/.env) or write ~/.gbrain/wakeshift.key.', KEY_HINT);
  try {
    return { key: parseWakeshiftKey(read.raw), source: read.source };
  } catch (e) {
    if (e instanceof WakeshiftKeyError) throw keyError(e.reason, e.message, KEY_HINT);
    throw e;
  }
}

async function watchCounts(engine: BrainEngine): Promise<Record<string, number>> {
  try {
    const rows = await engine.executeRaw<{ state: string; last_error: string | null; n: number }>(
      'SELECT state, last_error, count(*)::int AS n FROM wake_subscriptions GROUP BY state, last_error');
    const out: Record<string, number> = { open: 0, delivered: 0, dead: 0, ended: 0, id_reused: 0 };
    for (const r of rows) {
      out[r.state] = (out[r.state] ?? 0) + Number(r.n);
      if (r.last_error === 'id_reused') out.id_reused! += Number(r.n);
    }
    return out;
  } catch {
    return {};
  }
}

function writeFilePlane(update: (w: { enabled?: boolean; url?: string }) => { enabled?: boolean; url?: string }): void {
  const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as GBrainConfig & { wakeshift?: { enabled?: boolean; url?: string } };
  cfg.wakeshift = update({ ...(cfg.wakeshift ?? {}) });
  saveConfig(cfg);
}

function say(json: boolean, doc: Record<string, unknown>, lines: string[]): void {
  if (json) console.log(JSON.stringify(doc, null, 2));
  else for (const l of lines) console.log(l);
}

function describeWakeshiftError(e: unknown): string {
  return e instanceof WakeshiftError ? `${e.code} (HTTP ${e.status || 'none'}): ${e.message}` : String(e instanceof Error ? e.message : e);
}

async function status(engine: BrainEngine, json: boolean): Promise<void> {
  const file = wakeshiftFileConfig(loadConfigFileOnly());
  const read = readWakeshiftKey();
  let kid: string | null = null;
  let keyProblem: string | null = read.source === 'file_too_open' ? `key file mode ${read.mode} (must be 0600)` : read.source === 'none' ? 'no key' : null;
  if (read.source === 'env' || read.source === 'file') {
    try { kid = parseWakeshiftKey(read.raw).kid; } catch (e) { keyProblem = (e as Error).message; }
  }
  const counts = await watchCounts(engine);
  const on = file.enabled === true && kid !== null;
  say(json, { enabled: file.enabled === true, active: on, url: normalizeWakeshiftUrl(file.url), key: { source: read.source, kid, problem: keyProblem }, watches: counts }, [
    `Wakeshift reporting back: ${on ? 'on' : file.enabled === true ? 'enabled but inactive' : 'off'}`,
    `  url:     ${normalizeWakeshiftUrl(file.url)}`,
    `  key:     ${kid ? `${read.source} (kid ${kid})` : keyProblem}`,
    `  watches: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    ...(on || file.enabled !== true ? [] : ['  The watch tools stay hidden until the key problem above is fixed.']),
  ]);
}

async function enable(engine: BrainEngine, args: string[]): Promise<void> {
  const stdinKey = args.includes('--key-stdin') ? readFileSync(0, 'utf8').trim() : null;
  let loaded: { key: WakeshiftKey; source: 'env' | 'file' | 'stdin' };
  if (stdinKey !== null) {
    if (readWakeshiftKey().source === 'env') {
      throw keyError('env_overrides', 'WAKESHIFT_API_KEY is set (in the environment or ~/.gbrain/.env) and takes precedence over a saved key, so --key-stdin would save a key gbrain never uses. Nothing was saved.',
        'Remove WAKESHIFT_API_KEY, then run gbrain wakeshift enable --key-stdin again; or run gbrain wakeshift enable without --key-stdin to use it.');
    }
    try { loaded = { key: parseWakeshiftKey(stdinKey), source: 'stdin' }; } catch (e) { if (e instanceof WakeshiftKeyError) throw keyError(e.reason, e.message, KEY_HINT); throw e; }
  } else {
    loaded = loadKey();
  }
  const { key, source } = loaded;
  const members = await liveAccessMembers(engine);
  if (members > 0) {
    throw opError('wakeshift_shared_brain', `This brain has ${members} live access member(s); this release reports back only on a brain that serves its owner alone. Nothing was turned on.`,
      'Leave reporting back off on this brain; agents wait for a job with wait_job or gbrain jobs wait and the job id.');
  }
  const url = normalizeWakeshiftUrl(flagValue(args, '--url') ?? wakeshiftFileConfig(loadConfigFileOnly()).url);
  await requireConsent({
    command: 'wakeshift enable', effects: ['egress', 'credentials'], actor: 'user',
    what: `Turn on reporting back through Wakeshift (${url}) with the key kid ${key.kid}.`,
    why: 'Agents can then ask gbrain to wake their conversation when a job finishes, instead of polling.',
    risk: 'Each watched job sends Wakeshift a pointer: the job id, kind, status, times, a hashed user id, the MCP client name, user agent and request _meta. Never page text, titles or slugs. Members of your Wakeshift organization can read sent wakes.',
    user_message: 'Turn on gbrain reporting back through Wakeshift? It sends job ids and status (never page text) to Wakeshift when a watched job finishes.',
    argv: ['gbrain', 'wakeshift', 'enable'], args,
  });
  const api = wakeshiftClient(key, { url });
  let app;
  try {
    app = await api.getApp();
    await api.mergeManifest(wakeshiftManifest());
  } catch (e) {
    throw opError(e instanceof WakeshiftError && (e.status === 0 || e.status === 429 || e.status >= 500) ? 'wakeshift_unavailable' : 'wakeshift_refused',
      `Wakeshift did not accept the key or the manifest: ${describeWakeshiftError(e)}. Nothing was turned on.`,
      'Check the key belongs to your Wakeshift app (gbrain wakeshift test) and retry.', { reason: e instanceof WakeshiftError ? e.code : 'error' });
  }
  if (stdinKey !== null) {
    const tmp = `${wakeshiftKeyFile()}.${process.pid}.tmp`;
    writeFileSync(tmp, stdinKey + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, wakeshiftKeyFile());
    console.error(`[wakeshift] saved the key to ${wakeshiftKeyFile()} (0600).`);
  }
  wakeshiftSecret();
  writeFilePlane(w => {
    const next: { enabled?: boolean; url?: string } = { ...w, enabled: true, url };
    if (url === 'https://app.wakeshift.ai') delete next.url;
    return next;
  });
  say(args.includes('--json'), { enabled: true, url, app: { id: app?.id, name: app?.name }, key: { source, kid: key.kid } }, [
    `Wakeshift reporting back is on (app ${app?.name ?? '?'}, key kid ${key.kid}, from ${source}).`,
    'Agents now see watch_job, list_watches and unwatch; gbrain serve and the job worker deliver wakes.',
    'Turn it off with: gbrain wakeshift disable',
  ]);
}

async function disable(engine: BrainEngine, json: boolean): Promise<void> {
  writeFilePlane(w => ({ ...w, enabled: false }));
  const rows = await engine.executeRaw<{ id: number; wake_user: string; ws_subscription_id: string }>(
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'disabled', lease_until = NULL, updated_at = now() WHERE state = 'open'
     RETURNING id, wake_user, ws_subscription_id`);
  let told = 0;
  if (rows.length > 0) {
    try {
      const { key } = loadKey();
      const api = wakeshiftClient(key, { url: normalizeWakeshiftUrl(wakeshiftFileConfig(loadConfigFileOnly()).url) });
      for (const row of rows) if (await endAtWakeshift(api, row)) told++;
    } catch { /* no usable key: Wakeshift's own ttl ends them */ }
  }
  say(json, { enabled: false, ended: rows.length, told_wakeshift: told }, [
    'Wakeshift reporting back is off: the watch tools are hidden from the next tools/list.',
    `Ended ${rows.length} open watch(es)${rows.length ? ` (${told} confirmed by Wakeshift)` : ''}.`,
  ]);
}

async function test(json: boolean): Promise<void> {
  const { key, source } = loadKey();
  const url = normalizeWakeshiftUrl(wakeshiftFileConfig(loadConfigFileOnly()).url);
  try {
    const app = await wakeshiftClient(key, { url }).getApp();
    say(json, { ok: true, url, app: { id: app.id, name: app.name }, key: { source, kid: key.kid, key_id: app.key?.key_id } }, [
      `ok: Wakeshift accepted the key (app ${app.name}, key ${app.key?.name ?? app.key?.key_id ?? '?'}, kid ${key.kid}).`,
    ]);
  } catch (e) {
    say(json, { ok: false, url, key: { source, kid: key.kid }, error: describeWakeshiftError(e) }, [`fail: ${describeWakeshiftError(e)}`]);
    setCliExitVerdict(1);
  }
}

/** `gbrain config get mcp.publish_wakeshift`: the runtime gate, which never reads the DB plane. */
export function printWakeshiftGate(): void {
  console.log(String(wakeshiftPublished()));
  console.error('[config] source: wakeshift.enabled in the host file plane plus a usable Wakeshift key; the DB plane is never read for this gate (gbrain wakeshift status)');
}

export async function runWakeshift(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes('--json');
  if (!sub || args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (sub === 'status') return status(engine, json);
  if (sub === 'enable') return enable(engine, args.slice(1));
  if (sub === 'disable') return disable(engine, json);
  if (sub === 'test') return test(json);
  console.error(`Unknown wakeshift command: ${sub}\n\n${HELP}`);
  setCliExitVerdict(2);
}
