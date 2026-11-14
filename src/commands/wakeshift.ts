/**
 * `gbrain wakeshift enable | disable | status | test | cron | emit` (plan D2,
 * D4, D5): the trusted local switch for reporting back through Wakeshift.
 * Only this command writes the `wakeshift.*` keys (host file plane), so no
 * MCP or HTTP caller can turn it on. `enable` asks consent (egress,
 * credentials), requires the operator's terms and privacy links on a brain
 * with live access members, checks the key with GET /app, merges the event
 * manifest and stores its hash; `disable` hides the watch tools at once and
 * ends open watches; `status` and `test` show the key's kid fingerprint,
 * never the key, and `status` says when the published manifest is older than
 * this build. `cron add|remove|list` keeps the names watch_cron accepts;
 * `emit cron.finished` records a run for the drainer and never calls
 * Wakeshift or fails the cron script. Guide: docs/guides/wakeshift.md.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { requireConsent } from '../core/consent.ts';
import { WakeshiftError, WakeshiftKeyError, normalizeWakeshiftUrl, parseWakeshiftKey, wakeshiftClient, type WakeshiftKey } from '../core/wakeshift/client.ts';
import { readWakeshiftKey, wakeshiftFileConfig, wakeshiftKeyFile, wakeshiftPublished, wakeshiftRuntime, wakeshiftSecret, type WakeshiftFileConfig } from '../core/wakeshift/config.ts';
import { CRON_FINISHED, cronName, wakeshiftManifest, wakeshiftManifestHash } from '../core/wakeshift/events.ts';
import { endAtWakeshift, liveAccessMembers } from '../core/wakeshift/drain.ts';
import { WAKESHIFT_CONNECTOR_TERMS_URL, WAKESHIFT_PRIVACY_URL, httpsUrl, operatorTerms } from '../core/wakeshift/terms.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { shellQuote } from '../core/agent-output.ts';

const HELP = `gbrain wakeshift <command> — report back to agent conversations when jobs, writes and crons finish (off by default)

Commands:
  status [--json]            on/off, where the key comes from (its kid fingerprint only), watch counts,
                             and whether the published manifest is older than this build
  enable [--key-stdin] [--url <https url>] [--terms-url <https url> --privacy-url <https url>] [--yes]
                             turn reporting back on: asks consent, checks the key with Wakeshift and
                             publishes gbrain's events; --key-stdin saves the key from stdin to
                             ~/.gbrain/wakeshift.key (0600). A brain with access members needs your
                             terms and privacy links; each member accepts them before a first watch
  disable [--json]           turn it off: the watch tools disappear at once and open watches end
  test [--json]              check the key and the app with Wakeshift; sends no wake
  cron add <name> | remove <name> | list [--json]
                             the cron names agents may watch with watch_cron
  emit cron.finished --name <name> --status ok|failed
                             record a cron run at the end of the cron's script; the drainer wakes its
                             watchers. Never calls Wakeshift itself, and exits 0 when reporting back is off
  watch job <id> | write <request_id> | cron <name>
                             from a thin client or agent shell: wake this conversation when it finishes
                             (gbrain wakeshift watch --help)
  accept-terms <terms_version>
                             from a thin client or agent shell: record the user's agreement to a shared
                             brain's agreement step (accept_wakeshift_terms), then run the watch again

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

function writeFilePlane(update: (w: WakeshiftFileConfig) => WakeshiftFileConfig): void {
  const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as GBrainConfig & { wakeshift?: WakeshiftFileConfig };
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
  const manifestStale = file.enabled === true && file.manifest_hash !== wakeshiftManifestHash();
  const terms = operatorTerms(file);
  say(json, {
    enabled: file.enabled === true, active: on, url: normalizeWakeshiftUrl(file.url), key: { source: read.source, kid, problem: keyProblem }, watches: counts,
    manifest: { current: !manifestStale, ...(manifestStale ? { fix: shellQuote(['gbrain', 'wakeshift', 'enable']) } : {}) },
    terms: terms ? { terms_url: terms.terms_url, privacy_url: terms.privacy_url, version: terms.version } : null,
  }, [
    `Wakeshift reporting back: ${on ? 'on' : file.enabled === true ? 'enabled but inactive' : 'off'}`,
    `  url:     ${normalizeWakeshiftUrl(file.url)}`,
    `  key:     ${kid ? `${read.source} (kid ${kid})` : keyProblem}`,
    `  watches: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    ...(terms ? [`  terms:   ${terms.terms_url} and ${terms.privacy_url} (version ${terms.version})`] : []),
    ...(on || file.enabled !== true ? [] : ['  The watch tools stay hidden until the key problem above is fixed.']),
    ...(manifestStale ? ['  The published event manifest is older than this build: run gbrain wakeshift enable to publish the new events.'] : []),
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
  const saved = wakeshiftFileConfig(loadConfigFileOnly());
  const links: Pick<WakeshiftFileConfig, 'terms_url' | 'privacy_url'> = {};
  for (const [flag, field] of [['--terms-url', 'terms_url'], ['--privacy-url', 'privacy_url']] as const) {
    const raw = flagValue(args, flag);
    if (raw === undefined) continue;
    const url = httpsUrl(raw);
    if (!url) throw opError('invalid_params', `${flag} must be an absolute https URL (got ${JSON.stringify(raw.slice(0, 80))}).`, `Pass the https address of your published ${field === 'terms_url' ? 'terms' : 'privacy policy'}.`);
    links[field] = url;
  }
  const terms = operatorTerms({ ...saved, ...links });
  const members = await liveAccessMembers(engine);
  if (members > 0 && !terms) {
    throw opError('wakeshift_shared_brain', `This brain has ${members} live access member(s), and Wakeshift's terms make you, the operator, show each of them your own terms and privacy policy before any wake. Nothing was turned on.`,
      'Run gbrain wakeshift enable --terms-url <https url> --privacy-url <https url> with your published terms and privacy policy (they must refer members to Wakeshift\'s Connector Terms and Privacy Policy); each member then accepts them once before a first watch.');
  }
  const url = normalizeWakeshiftUrl(flagValue(args, '--url') ?? saved.url);
  const operatorDuty = members > 0
    ? ` This brain has ${members} access member(s): as the operator you are the controller of their wake data and Wakeshift is your processor (its DPA). Your terms (${terms!.terms_url}) and privacy policy (${terms!.privacy_url}) must refer members to Wakeshift's Connector Terms (${WAKESHIFT_CONNECTOR_TERMS_URL}) and Privacy Policy (${WAKESHIFT_PRIVACY_URL}), incorporate them and name Clawvisor Inc. as a third-party beneficiary (Wakeshift ToS 6.6), state a minimum age for members, and say that wakes pass through Wakeshift. Each member accepts your terms once before a first watch.`
    : '';
  await requireConsent({
    command: 'wakeshift enable', effects: ['egress', 'credentials'], actor: 'user',
    what: `Turn on reporting back through Wakeshift (${url}) with the key kid ${key.kid}.`,
    why: 'Agents can then ask gbrain to wake their conversation when a job, a pending write or a scheduled cron finishes, instead of polling.',
    risk: `Each watched job, write request or cron sends Wakeshift a pointer: its id or cron name, kind, status, times, a hashed user id, the MCP client name, user agent and request _meta. Never page text, titles or slugs. Members of your Wakeshift organization can read sent wakes.${operatorDuty}`,
    user_message: `Turn on gbrain reporting back through Wakeshift? It sends ids and status (never page text) to Wakeshift when a watched job, write or cron finishes.${members > 0 ? ' This brain has members, so your terms and privacy policy must refer them to Wakeshift\'s Connector Terms and Privacy Policy.' : ''}`,
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
    const next: WakeshiftFileConfig = { ...w, ...links, enabled: true, url, manifest_hash: wakeshiftManifestHash() };
    if (url === 'https://app.wakeshift.ai') delete next.url;
    return next;
  });
  say(args.includes('--json'), { enabled: true, url, app: { id: app?.id, name: app?.name }, key: { source, kid: key.kid }, ...(terms ? { terms_version: terms.version } : {}) }, [
    `Wakeshift reporting back is on (app ${app?.name ?? '?'}, key kid ${key.kid}, from ${source}).`,
    'Agents now see watch_job, watch_write_request, watch_cron, list_watches and unwatch; gbrain serve and the job worker deliver wakes.',
    ...(members > 0 ? [`Members see your terms (version ${terms!.version}) on their first watch and accept them with accept_wakeshift_terms; changing a link asks again.`] : []),
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

/** `cron add|remove|list`: the names watch_cron accepts (slugged to [a-z0-9._-], at most 64). Local state; works with reporting back off. */
async function cron(engine: BrainEngine, args: string[], json: boolean): Promise<void> {
  const [verb, raw] = args;
  if (verb === 'list') {
    const rows = await engine.executeRaw<{ name: string; created_at: Date | string; last_status: string | null; last_finished_at: Date | string | null }>(
      `SELECT c.name, c.created_at, r.status AS last_status, r.finished_at AS last_finished_at FROM wake_crons c
        LEFT JOIN LATERAL (SELECT status, finished_at FROM wake_cron_runs WHERE name = c.name ORDER BY finished_at DESC, id DESC LIMIT 1) r ON true
        ORDER BY c.name`);
    say(json, { crons: rows }, rows.length ? rows.map(r => `${r.name}${r.last_status ? `  last run: ${r.last_status} at ${new Date(r.last_finished_at!).toISOString()}` : '  no run reported yet'}`) : ['No crons registered (gbrain wakeshift cron add <name>).']);
    return;
  }
  const name = cronName(raw);
  if ((verb !== 'add' && verb !== 'remove') || !name) {
    console.error('Usage: gbrain wakeshift cron add <name> | remove <name> | list [--json]');
    setCliExitVerdict(2);
    return;
  }
  const renamed = name !== raw ? ` (stored as ${name})` : '';
  if (verb === 'add') {
    await engine.executeRaw('INSERT INTO wake_crons (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    say(json, { name, registered: true }, [`Registered cron ${name}${renamed}. End its script with: gbrain wakeshift emit cron.finished --name ${name} --status ok (or failed).`]);
    return;
  }
  await engine.executeRaw('DELETE FROM wake_crons WHERE name = $1', [name]);
  const ended = await engine.executeRaw<{ id: number; wake_user: string; ws_subscription_id: string }>(
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'cron_removed', lease_until = NULL, updated_at = now()
      WHERE state = 'open' AND event = $1 AND target = $2 RETURNING id, wake_user, ws_subscription_id`, [CRON_FINISHED, name]);
  const api = ended.length ? wakeshiftRuntime()?.api : undefined;
  if (api) for (const row of ended) await endAtWakeshift(api, row);
  say(json, { name, registered: false, ended: ended.length }, [`Removed cron ${name}${renamed}; ended ${ended.length} open watch(es) on it.`]);
}

/**
 * `emit cron.finished --name <name> --status ok|failed`: record the run for the drainer and return. Never calls
 * Wakeshift and exits 0 whatever happens after the arguments parse (off, unregistered, a database error), with one
 * stderr line, so the cron script's own exit status stays its own.
 */
function emitArgs(args: string[]): { name: string; status: 'ok' | 'failed' } | null {
  const name = cronName(flagValue(args, '--name'));
  const status = flagValue(args, '--status');
  if (args[0] === 'cron.finished' && name && (status === 'ok' || status === 'failed')) return { name, status };
  console.error('Usage: gbrain wakeshift emit cron.finished --name <name> --status ok|failed');
  setCliExitVerdict(2);
  return null;
}

/**
 * The brain could not be opened for `emit` (a live serve holding the PGLite lock, a database outage): the run is not
 * recorded, but the cron script still keeps its own exit status, as the emit contract promises.
 */
export function reportEmitConnectFailure(args: string[], error: unknown): void {
  const parsed = emitArgs(args);
  if (!parsed) return;
  console.error(`[wakeshift] could not record the ${parsed.name} run: the brain could not be opened (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).`);
}

async function emit(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = emitArgs(args);
  if (!parsed) return;
  const { name, status } = parsed;
  if (!wakeshiftPublished()) {
    console.error(`[wakeshift] reporting back is off, so the ${name} run was not recorded (gbrain wakeshift status).`);
    return;
  }
  try {
    await engine.executeRaw('INSERT INTO wake_cron_runs (name, status) VALUES ($1, $2)', [name, status]);
    await engine.executeRaw("DELETE FROM wake_cron_runs WHERE name = $1 AND finished_at < now() - interval '30 days'", [name]);
    const registered = await engine.executeRaw('SELECT 1 FROM wake_crons WHERE name = $1', [name]);
    if (registered.length === 0) console.error(`[wakeshift] cron ${name} is not registered, so no agent can watch it: run gbrain wakeshift cron add ${name}.`);
  } catch (e) {
    console.error(`[wakeshift] could not record the ${name} run: ${e instanceof Error ? e.message : String(e)}`);
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
  if (sub === 'watch' || sub === 'accept-terms') return (await import('./wakeshift-watch.ts')).runWakeshiftWatch(engine, sub === 'watch' ? args.slice(1) : args);
  if (!sub || args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (sub === 'status') return status(engine, json);
  if (sub === 'enable') return enable(engine, args.slice(1));
  if (sub === 'disable') return disable(engine, json);
  if (sub === 'test') return test(json);
  if (sub === 'cron') return cron(engine, args.slice(1), json);
  if (sub === 'emit') return emit(engine, args.slice(1));
  console.error(`Unknown wakeshift command: ${sub}\n\n${HELP}`);
  setCliExitVerdict(2);
}
