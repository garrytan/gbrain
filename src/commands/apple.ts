/**
 * gbrain apple — setup / status / services for the Apple connector
 * (Calendar, Contacts, Mail on macOS; issue #6855).
 *
 * Same agent contract as `gbrain google` (docs/guides/apple-connect.md):
 *  - every subcommand supports --json and emits
 *    { ok, status, next_action?: { command?, user_message? }, error? };
 *  - text the harness should relay verbatim is fenced in [SHOW USER] blocks;
 *  - exit 0 done, 1 failed, 2 waiting on the user (contract v1, legacy);
 *  - idempotent: re-running setup is the documented fix for most states.
 *
 * Read-only toward Apple: this command reads nothing but a per-service
 * permission probe; the sync (which reads items) runs only inside `setup`
 * after the probes pass, unless --no-sync. It holds no credential.
 *
 * `runApple` returns the exit code instead of setting it, and takes its
 * readers, platform, engine and sync as injectable deps, so tests need
 * neither macOS nor a spawned process.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { AppleMailRouting, AppleReaders, AppleService, AppleSourceConfig } from '../core/apple/types.ts';
import { ALL_APPLE_SERVICES } from '../core/apple/types.ts';
import { parseAppleSourceConfig } from '../core/apple/source-config.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { permissionGuide, guideLines, USER_ACTION_CODES, type PermissionGuide } from '../core/apple/permission-guide.ts';
import { APPLE_DEFAULT_ACCOUNT } from '../core/apple/source-config.ts';
import { APPLE_LOOPS_EXTRACT_DISCLOSURE, appleLoopsAvailability } from '../core/apple/loops-status.ts';
import { APPLE_MAIL_GOOGLE_DISCLOSURE, GOOGLE_SETUP_COMMAND, routingSummary } from '../core/apple/mail-routing.ts';
import { AppleAddFlagError, appleAddPlatformWarning, buildAppleAddOptions, parseAppleServicesFlag } from './sources-apple-flags.ts';
import { emitEnvelope, errorEnvelope, showUserBlock, type AppleOut } from './apple-output.ts';

export interface AppleSyncResultLike { status: string; added: number; modified: number; deleted: number }

export interface AppleCommandDeps {
  readers?: AppleReaders;
  platform?: string;
  /** An already-open engine (tests); otherwise one is opened from the brain config and closed afterwards. */
  engine?: BrainEngine;
  write?: (text: string) => void;
  errWrite?: (text: string) => void;
  /** First-sync runner (tests); defaults to performSync. */
  sync?: (engine: BrainEngine, opts: { sourceId: string; signal: AbortSignal }) => Promise<AppleSyncResultLike>;
  now?: () => number;
  /**
   * Whether a person is at this terminal. Default: stdin and stdout are TTYs. Setup only asks macOS to show a
   * permission prompt when interactive or when --yes was passed; otherwise it tells the user a prompt is coming.
   */
  interactive?: boolean;
}

interface Flags {
  json: boolean;
  services?: string;
  account?: string;
  source?: string;
  noSync: boolean;
  noProbe: boolean;
  yes: boolean;
  confirmMail: boolean;
  consentExtraction: boolean;
  revokeExtraction: boolean;
  budgetMs: number;
  /** The `sources add` tuning flags, by flag name (`--history-days` ...). */
  extra: Record<string, string>;
  positionals: string[];
}

const VALUED = new Set(['--services', '--account', '--source', '--sync-budget-ms', '--history-days', '--future-days', '--calendar-ids', '--contacts-dir', '--mail-mailboxes', '--mail-days', '--mail-owner-addresses']);
const BOOLEAN = new Set(['--json', '--no-sync', '--no-probe', '--yes', '--confirm-mail', '--consent-loops-extraction', '--revoke-loops-extraction']);

export const APPLE_HELP = `gbrain apple — connect Apple Calendar, Contacts and Mail (macOS) to your brain

Subcommands:
  setup     check macOS permissions, register the source, run a first sync (one command; idempotent)
            --services calendar,contacts,mail   which services (default: all three)
            --account <label>                   free label for this Mac's account (default: local; not a credential)
            --yes | --confirm-mail              required when Mail is selected (Mail is the most sensitive service; Google-hosted Mail accounts are never read here: use gbrain google setup)
            --no-sync                           register only; sync later with: gbrain sync --source <id>
            --sync-budget-ms <ms>               first-sync wall-clock budget (default 90000)
            --source <id>                       source id (default: apple-<account>)
            --mail-owner-addresses a@x,b@y      your addresses; enables unanswered-mail tracking (never guessed from Sent)
            --consent-loops-extraction          also send Mail thread text to the configured chat provider for commitment extraction (off by default)
            (+ --history-days --future-days --calendar-ids --contacts-dir --mail-mailboxes --mail-days)
  loops     [--source <id>] [--mail-owner-addresses a@x,b@y] [--consent-loops-extraction | --revoke-loops-extraction]  [--json]
            show or change Mail open-loop tracking for an existing Apple source (no Apple data is read)
  status    per-service permission probe, last sync, held items  [--json] [--no-probe]
            (--no-probe: no helper runs; reports the last probe recorded by a sync)
  services  [<source>]  list which services are enabled / disabled for a source  [--json]
            change them with: gbrain sources set-services <source> --add|--remove <service>

Exit codes: 0 done, 1 failed, 2 waiting on you (a permission, or a Mail confirmation).
Read-only toward Apple. No credentials. Docs: docs/guides/apple-connect.md`;

function parseFlags(args: string[]): Flags | { error: string } {
  const f: Flags = { json: false, noSync: false, noProbe: false, yes: false, confirmMail: false, consentExtraction: false, revokeExtraction: false, budgetMs: 90_000, extra: {}, positionals: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    if (BOOLEAN.has(key)) {
      if (eq > 0) return { error: `${key} does not accept a value.` };
      if (key === '--json') f.json = true;
      else if (key === '--no-sync') f.noSync = true;
      else if (key === '--no-probe') f.noProbe = true;
      else if (key === '--yes') f.yes = true;
      else if (key === '--consent-loops-extraction') f.consentExtraction = true;
      else if (key === '--revoke-loops-extraction') f.revokeExtraction = true;
      else f.confirmMail = true;
      continue;
    }
    if (VALUED.has(key)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) return { error: `${key} requires a value.` };
      if (key === '--services') f.services = value;
      else if (key === '--account') f.account = value;
      else if (key === '--source') f.source = value;
      else if (key === '--sync-budget-ms') f.budgetMs = Number(value) > 0 ? Number(value) : 90_000;
      else f.extra[key] = value;
      continue;
    }
    if (a.startsWith('-')) return { error: `Unknown option ${a}.` };
    f.positionals.push(a);
  }
  return f;
}

/** `apple-<account>` shaped into a valid source id (1-32 lowercase letters, digits, inner hyphens). */
export function deriveAppleSourceId(account: string): string {
  const id = `apple-${account}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '');
  return id || 'apple';
}

interface AppleSourceRow { id: string; local_path: string | null; incarnation: string; last_sync_at: unknown; config: Record<string, unknown>; cfg: AppleSourceConfig }

async function listAppleSources(engine: BrainEngine): Promise<AppleSourceRow[]> {
  const rows = await engine.executeRaw<{ id: string; local_path: string | null; incarnation: string; last_sync_at: unknown; config: unknown }>(
    'SELECT id, local_path, incarnation::text AS incarnation, last_sync_at, config FROM sources WHERE archived IS NOT TRUE ORDER BY id');
  const out: AppleSourceRow[] = [];
  for (const r of rows) {
    const config = parseSourceConfig(r.config);
    if (config.kind !== 'apple') continue;
    out.push({ ...r, config, cfg: parseAppleSourceConfig(config, r.local_path ?? '') });
  }
  return out;
}

async function openEngine(deps: AppleCommandDeps): Promise<{ engine: BrainEngine; close(): Promise<void> } | null> {
  if (deps.engine) return { engine: deps.engine, close: async () => {} };
  try {
    const { loadConfig, toEngineConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (!cfg) return null;
    const { createEngine } = await import('../core/engine-factory.ts');
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return { engine, close: () => engine.disconnect().catch(() => {}) };
  } catch {
    return null;
  }
}

async function defaultReaders(deps: AppleCommandDeps): Promise<AppleReaders> {
  if (deps.readers) return deps.readers;
  const { createAppleReaders } = await import('../core/apple/readers/index.ts');
  return createAppleReaders(deps.platform ? { platform: deps.platform as NodeJS.Platform } : {});
}

// ── setup ────────────────────────────────────────────────────────────────────

const shellArg = (s: string): string => /^[a-zA-Z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";

function setupCommand(f: Flags, services: AppleService[], extra: string[] = []): string {
  const parts = ['gbrain', 'apple', 'setup', '--services', services.join(',')];
  if (f.account) parts.push('--account', f.account);
  if (f.source) parts.push('--source', f.source);
  for (const [key, value] of Object.entries(f.extra)) parts.push(key, value);
  if (f.noSync) parts.push('--no-sync');
  if (f.json) parts.push('--json');
  if (f.yes) parts.push('--yes');
  if (f.consentExtraction) parts.push('--consent-loops-extraction');
  parts.push('--sync-budget-ms', String(f.budgetMs));
  return [...parts, ...extra].map(shellArg).join(' ');
}

/** Explicit id always wins; account labels are not unique ids. */
function setupSource(rows: AppleSourceRow[], f: Flags, sourceId: string, account: string): AppleSourceRow | undefined {
  if (f.source) return rows.find(s => s.id === sourceId);
  const matches = rows.filter(s => s.cfg.account === account);
  if (matches.length > 1) throw new Error('More than one Apple source has this account label; pass --source <id> explicitly.');
  return matches[0];
}

const sameScopeValue = (a: unknown, b: unknown): boolean => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);
function setupScopeMismatch(f: Flags, requested: AppleSourceConfig, stored: AppleSourceConfig): string | undefined {
  if (!sameScopeValue(requested.services, stored.services)) return 'services';
  if (f.account !== undefined && requested.account !== stored.account) return 'account';
  const fields = { '--history-days': 'historyDays', '--future-days': 'futureDays', '--calendar-ids': 'calendarIds',
    '--contacts-dir': 'contactsDir', '--mail-mailboxes': 'mailMailboxes', '--mail-days': 'mailDays', '--mail-owner-addresses': 'mailOwnerAddresses' } as const;
  for (const [flag, field] of Object.entries(fields)) if (f.extra[flag] !== undefined && !sameScopeValue(requested[field as keyof AppleSourceConfig], stored[field as keyof AppleSourceConfig])) return flag;
  if (f.consentExtraction && !stored.loopsExtractConsent) return 'extraction_consent';
  return undefined;
}

async function runSetup(f: Flags, deps: AppleCommandDeps, out: AppleOut): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const fail = (e: ReturnType<typeof errorEnvelope>, code = 1): number => { emitEnvelope(out, e.envelope, e.human); return code; };
  if (platform !== 'darwin') {
    return fail(errorEnvelope('unsupported_platform', 'The Apple connector only runs on macOS.',
      `It reads Calendar, Contacts and Mail through macOS frameworks; this host is ${platform}.`,
      'Run `gbrain apple setup` on the Mac whose Calendar, Contacts and Mail you want. Nothing was changed here.'));
  }
  if (f.revokeExtraction) return fail(errorEnvelope('invalid_value', 'Extraction revocation is a loops command, not a setup option.',
    'Setup must not silently ignore a request to revoke paid Mail extraction.',
    'Run gbrain apple loops --source <id> --revoke-loops-extraction first; setup reads nothing until then.'));
  let services: AppleService[];
  let addOpts;
  try {
    services = f.services === undefined ? [...ALL_APPLE_SERVICES] : parseAppleServicesFlag(f.services);
    const { defaultCloneDir } = await import('../core/sources-ops.ts');
    const sourceId = f.source ?? deriveAppleSourceId(f.account ?? 'local');
    addOpts = buildAppleAddOptions({
      services: services.join(','), account: f.account,
      historyDays: f.extra['--history-days'], futureDays: f.extra['--future-days'],
      calendarIds: f.extra['--calendar-ids'], contactsDir: f.extra['--contacts-dir'],
      mailMailboxes: f.extra['--mail-mailboxes'], mailDays: f.extra['--mail-days'], mailOwnerAddresses: f.extra['--mail-owner-addresses'],
      loopsExtractConsent: f.consentExtraction,
      // setup has its own Mail gate just below (--confirm-mail / --yes), which runs before any probe.
      confirmMail: true,
      dir: defaultCloneDir(`${sourceId}-apple`),
    });
  } catch (error) {
    if (error instanceof AppleAddFlagError) return fail(errorEnvelope(error.code, error.message, 'The service list is the privacy scope of this source, so a bad value never widens it.', error.suggestion));
    throw error;
  }
  let sourceId = f.source ?? deriveAppleSourceId(addOpts.account ?? 'local');

  // Resolve the registered source and its effective privacy scope BEFORE confirmation or probing.
  const preflight = await openEngine(deps);
  let existingBeforeProbe: AppleSourceRow | undefined;
  const { appleAddConfig } = await import('../core/apple/source-add-config.ts');
  const requested = parseAppleSourceConfig(appleAddConfig(addOpts, addOpts.dir, false), addOpts.dir);
  let effectiveCfg: AppleSourceConfig = requested;
  if (preflight) try {
    try { existingBeforeProbe = setupSource(await listAppleSources(preflight.engine), f, sourceId, addOpts.account ?? APPLE_DEFAULT_ACCOUNT); }
    catch (e) { return fail(errorEnvelope('ambiguous_source', String(e), 'Account labels are not unique.', 'Re-run with --source <id>.'), 2); }
    if (existingBeforeProbe) {
      const mismatch = setupScopeMismatch(f, requested, existingBeforeProbe.cfg);
      if (mismatch) return fail(errorEnvelope(mismatch === 'services' ? 'service_scope_mismatch' : 'source_scope_mismatch',
        `Source ${existingBeforeProbe.id} has a different ${mismatch} scope.`, 'Setup never silently ignores explicit selectors.',
        'Use the source configuration commands to change its scope explicitly, or pass a new --source id.'), 2);
      sourceId = existingBeforeProbe.id;
    } else {
      const [taken] = await preflight.engine.executeRaw('SELECT id FROM sources WHERE id=$1', [sourceId]);
      if (taken) return fail(errorEnvelope('source_id_taken', `Source id "${sourceId}" is already used.`, 'It is not an available Apple source.', 'Pick another --source id.'));
    }
    effectiveCfg = existingBeforeProbe?.cfg ?? requested;
  } finally { await preflight.close(); }
  // Pin retries to the actual source and every selected read window, including inherited scope.
  f = { ...f, source: sourceId, account: effectiveCfg.account, extra: { ...f.extra } };
  if (services.includes('mail')) {
    f.extra['--mail-mailboxes'] = effectiveCfg.mailMailboxes.join(',');
    f.extra['--mail-days'] = String(effectiveCfg.mailDays);
    if (effectiveCfg.mailOwnerAddresses.length) f.extra['--mail-owner-addresses'] = effectiveCfg.mailOwnerAddresses.join(',');
  }
  if (services.includes('calendar')) {
    f.extra['--history-days'] = String(effectiveCfg.historyDays);
    f.extra['--future-days'] = String(effectiveCfg.futureDays);
    if (effectiveCfg.calendarIds.length) f.extra['--calendar-ids'] = effectiveCfg.calendarIds.join(',');
  }
  if (services.includes('contacts')) f.extra['--contacts-dir'] = effectiveCfg.contactsDir;

  // Mail first, before any probe: probing Mail triggers a macOS Automation prompt, so consent comes before it.
  if (services.includes('mail') && !f.yes && !f.confirmMail) {
    const command = setupCommand(f, services, ['--confirm-mail']);
    const message = 'Mail is the most sensitive service: gbrain will read the subject, sender, recipients, date and plain-text body of recent messages '
      + `(mailboxes ${effectiveCfg.mailMailboxes.join(', ')}, last ${effectiveCfg.mailDays} days) from Mail.app and store them as pages in your brain. `
      + 'Attachments are never downloaded. ' + APPLE_MAIL_GOOGLE_DISCLOSURE + ' '
      + 'Nothing leaves this Mac except the text sent to your configured AI provider if atom extraction runs on those pages, or if you separately consent to commitment extraction (--consent-loops-extraction, which needs --mail-owner-addresses and sends Mail thread text to the chat provider configured for this brain). '
      + (effectiveCfg.loopsExtractConsent ? 'Commitment extraction is currently enabled for this source and sends eligible Mail threads to your configured chat provider. ' : '')
      + `Skip Mail with --services calendar,contacts. Confirm Mail by re-running with --confirm-mail (or --yes).`;
    emitEnvelope(out, { ok: false, status: 'awaiting_confirmation', services, source_id: sourceId, next: { command, user_message: message } },
      [showUserBlock(message, command), '', `Next: ${command}`]);
    return 2;
  }

  if (!preflight) return fail(errorEnvelope('no_brain', 'No gbrain brain is configured yet.', 'Cannot resolve the effective Apple source.', 'Run gbrain init first.'), 2);

  // Probe every selected service (the only Apple access setup makes before the sync).
  const readers = await defaultReaders(deps);
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const probes: Array<{ service: AppleService; ok: boolean; code?: string; fix?: string }> = [];
  const denied: PermissionGuide[] = [];
  const pending: PermissionGuide[] = [];
  const broken: Array<{ service: AppleService; code: string; fix: string }> = [];
  let mailRouting: AppleMailRouting | undefined;
  for (const service of services) {
    let result = await readers.probe(service);
    // Not yet asked (permission_not_determined) is not a denial: macOS has not shown its prompt. A probe never
    // prompts, so ask once by running the reader's request (no item is read) and probe again.
    if (!result.ok && result.code === 'permission_not_determined' && readers.requestAccess && (interactive || f.yes)) {
      await readers.requestAccess(service);
      result = await readers.probe(service);
    }
    if (result.ok) { probes.push({ service, ok: true }); if (service === 'mail' && result.routing) mailRouting = result.routing; continue; }
    probes.push({ service, ok: false, code: result.code, fix: result.fix });
    if (result.code === 'permission_not_determined') pending.push(permissionGuide(service, result.code, result.fix));
    else if (USER_ACTION_CODES.includes(result.code)) denied.push(permissionGuide(service, result.code, result.fix));
    else broken.push({ service, code: result.code, fix: result.fix });
  }
  // Mail accounts are classified from public metadata only. One that cannot be told apart from Google stops setup before
  // anything is registered or synced, Calendar and Contacts included: the owner decides (fix the account, or opt Mail out).
  const unknownMail = broken.find((b) => b.service === 'mail' && b.code === 'mail_routing_unknown');
  if (unknownMail) {
    const withoutMail = services.filter((x) => x !== 'mail');
    return fail(errorEnvelope('mail_routing_unknown', 'Mail has an enabled account whose provider cannot be told apart from Google.',
      'Reading it could import Google mail through Apple Mail, so setup stopped before registering or syncing anything (Calendar and Contacts included).',
      unknownMail.fix, withoutMail.length > 0 ? { command: setupCommand(f, withoutMail), user_message: 'Re-run without Mail to connect Calendar and Contacts only.' } : undefined));
  }
  if (broken.length > 0) {
    const first = broken[0]!;
    return fail(errorEnvelope('probe_failed', `The ${first.service} probe failed (${first.code}).`,
      broken.map((b) => `${b.service}: ${b.code}`).join('; '), first.fix, { command: setupCommand(f, services, services.includes('mail') ? ['--confirm-mail'] : []) }));
  }
  if (mailRouting?.status === 'google_only') {
    // Every enabled Mail account is Google-hosted: the Google connector owns that mail. Nothing is registered or synced.
    const withoutMail = services.filter((x) => x !== 'mail');
    const message = 'Every enabled account in Mail.app is a Google account (Gmail or Google Workspace). gbrain reads that mail through the Google connector, never through Apple Mail, so Apple Mail has nothing to read. '
      + `Connect Google: ${GOOGLE_SETUP_COMMAND}. ${withoutMail.length > 0 ? `To connect only ${withoutMail.join(' and ')} here, re-run with --services ${withoutMail.join(',')}. ` : ''}Nothing was registered or synced.`;
    emitEnvelope(out, { ok: false, status: 'awaiting_google_setup', services, source_id: sourceId, probes, mail_routing: routingSummary(mailRouting), next: { command: GOOGLE_SETUP_COMMAND, user_message: message } },
      [showUserBlock(message, GOOGLE_SETUP_COMMAND), '', `Next: ${GOOGLE_SETUP_COMMAND}`]);
    return 2;
  }
  if (denied.length > 0 || pending.length > 0) {
    const command = setupCommand(f, services, services.includes('mail') ? ['--confirm-mail'] : []);
    const promptNote = pending.length === 0 ? [] : [
      `macOS has not asked for ${pending.map((g) => g.service).join(', ')} access yet. ${interactive || f.yes
        ? 'The permission prompt did not get an answer.'
        : `A permission prompt will appear on this Mac's screen when setup runs from a terminal on it (add --yes to ask right now).`} `
        + 'Click Allow on the prompt; if no prompt appears, enable the app that runs gbrain in System Settings > Privacy & Security.',
      '',
    ];
    const message = ['gbrain needs your permission to read these Apple services. Grant it, then I will re-run setup:', '', ...promptNote,
      ...denied.flatMap((g) => [...guideLines(g), ''])].join('\n').trimEnd();
    const needed = [...pending, ...denied];
    emitEnvelope(out, { ok: false, status: 'awaiting_permission', services, source_id: sourceId, probes, denied: needed.map((g) => ({ service: g.service, code: g.code, pane: g.pane, app: g.app, fix: g.fix })), next: { command, user_message: message } },
      [showUserBlock(message, command), '', `Then re-run: ${command}`]);
    return 2;
  }

  // Register (idempotent) and sync.
  const handle = await openEngine(deps);
  if (!handle) {
    return fail(errorEnvelope('no_brain', 'No gbrain brain is configured yet.', 'The permission probes passed, but there is no brain to register the source in.',
      'Run `gbrain init`, then re-run `gbrain apple setup`.', { command: 'gbrain init' }), 2);
  }
  try {
    const { engine } = handle;
    const existing = (await listAppleSources(engine)).find(s => s.id === sourceId);
    if ((existingBeforeProbe && (!existing || !sameScopeValue(existing.config, existingBeforeProbe.config))) || (!existingBeforeProbe && existing)) {
      return fail(errorEnvelope('source_scope_changed', 'Apple source changed during setup.', 'The probed/confirmed source must match execution.', 'Re-run the same setup command to confirm the current scope.'), 2);
    }
    let registeredId = sourceId;
    let registered = false;
    if (existing) {
      registeredId = existing.id;
    } else {
      const [taken] = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id=$1', [sourceId]);
      if (taken) {
        return fail(errorEnvelope('source_id_taken', `Source id "${sourceId}" is already used by a non-Apple source.`, 'Setup would have to replace it.',
          `Pick another id: gbrain apple setup --source <id>${f.account ? '' : ' --account <label>'}`));
      }
      const { addSource } = await import('../core/sources-ops.ts');
      await addSource(engine, { id: sourceId, apple: addOpts });
      registered = true;
    }
    let syncSummary: (AppleSyncResultLike & { partial: boolean }) | null = null;
    if (!f.noSync) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), f.budgetMs);
      try {
        const run = deps.sync ?? (async (e: BrainEngine, o: { sourceId: string; signal: AbortSignal }) => (await (await import('./sync.ts')).performSync(e, o)) as AppleSyncResultLike);
        const result = await run(engine, { sourceId: registeredId, signal: controller.signal });
        syncSummary = { ...result, partial: result.status === 'partial' };
      } catch (error) {
        return fail(errorEnvelope('sync_failed', 'The first sync failed.', error instanceof Error ? error.message : String(error),
          `The source is registered. Retry: gbrain sync --source ${registeredId}`, { command: `gbrain sync --source ${registeredId}` }));
      } finally {
        clearTimeout(timer);
      }
    }
    const effective = existing?.cfg.services ?? services;
    const next = f.noSync ? `gbrain sync --source ${registeredId}` : 'gbrain apple status';
    const humanSync = syncSummary ? `First sync: ${syncSummary.added + syncSummary.modified} pages (${syncSummary.status}).${syncSummary.partial ? ' The rest resumes on every later sync.' : ''}` : 'Sync skipped (--no-sync).';
    const warning = appleAddPlatformWarning(platform);
    emitEnvelope(out, {
      ok: true, status: 'ok', source_id: registeredId, registered, already_registered: !registered, services: effective, probes,
      ...(mailRouting ? { mail_routing: routingSummary(mailRouting) } : {}),
      ...(syncSummary ? { sync: { status: syncSummary.status, added: syncSummary.added, modified: syncSummary.modified, deleted: syncSummary.deleted, partial: syncSummary.partial } } : {}),
      ...(existing && existing.cfg.services.join(',') !== services.join(',') ? { note: `Source ${existing.id} already exists with services ${existing.cfg.services.join(', ')}; change them with: gbrain sources set-services ${existing.id} --add|--remove <service>` } : {}),
      next: { command: next, user_message: `Apple source ${registeredId} ${registered ? 'registered' : 'already registered'} (${effective.join(', ')}).`
        + (mailRouting && mailRouting.google.length > 0 ? ` ${mailRouting.google.length} Google-hosted Mail account(s) are excluded from Apple Mail; read those only through ${GOOGLE_SETUP_COMMAND}.` : '') },
    }, [
      `${registered ? 'Registered' : 'Already registered'} source "${registeredId}" (${effective.join(', ')}); permissions OK for ${services.join(', ')}.`,
      humanSync, ...(warning ? [warning] : []),
      ...(mailRouting && mailRouting.google.length > 0 ? [`Mail: ${mailRouting.google.length} Google-hosted account(s) are excluded from Apple Mail and read only through the Google connector (${GOOGLE_SETUP_COMMAND}); ${mailRouting.eligible.length} other account(s) are read.`] : []),
      `Unattended runs (autopilot, a daemon) cannot show macOS permission prompts: if a service was never granted, run \`gbrain sync --source ${registeredId}\` once from a terminal on this Mac so macOS can ask. Next: ${next}`,
    ]);
    return 0;
  } finally {
    await handle.close();
  }
}

// ── status ───────────────────────────────────────────────────────────────────

async function runStatus(f: Flags, deps: AppleCommandDeps, out: AppleOut): Promise<number> {
  const handle = await openEngine(deps);
  if (!handle) {
    emitEnvelope(out, { ok: false, status: 'not_configured', sources: [], next: { command: 'gbrain apple setup' } },
      ['No gbrain brain is configured yet, so there is no Apple source. Run `gbrain apple setup` (after `gbrain init`).']);
    return 1;
  }
  try {
    const { engine } = handle;
    const sources = (await listAppleSources(engine)).filter((s) => !f.source || s.id === f.source);
    if (sources.length === 0) {
      emitEnvelope(out, { ok: false, status: 'not_configured', sources: [], next: { command: 'gbrain apple setup' } },
        ['No Apple source is registered. Run `gbrain apple setup` to connect Calendar, Contacts and Mail.']);
      return 1;
    }
    const readers = f.noProbe ? null : await defaultReaders(deps);
    const { readConnectorCursorState, readAllSourceHolds } = await import('../core/connectors/item-holds-store.ts');
    const report: Array<Record<string, unknown>> = [];
    let unreadable = false;
    let googleOnly = false;
    for (const s of sources) {
      let recorded: Record<string, { ok: boolean; at: string; code?: string }> = {};
      try { recorded = ((await readConnectorCursorState(engine, { id: s.id, incarnation: s.incarnation, local_path: s.local_path, config: s.config }))?.last_probe ?? {}) as typeof recorded; } catch { /* unknown stays empty */ }
      const perService: Record<string, unknown> = {};
      for (const service of ALL_APPLE_SERVICES) {
        if (!s.cfg.services.includes(service)) { perService[service] = { enabled: false }; continue; }
        if (readers) {
          const result = await readers.probe(service);
          if (!result.ok) unreadable = true;
          if (result.ok && result.routing?.status === 'google_only') googleOnly = true;
          perService[service] = result.ok ? { enabled: true, ok: true, live: true, ...(service === 'mail' && result.routing ? { routing: routingSummary(result.routing) } : {}) }
            : { enabled: true, ok: false, live: true, code: result.code, fix: result.fix, ...pick(permissionGuide(service, result.code, result.fix)) };
        } else {
          const last = recorded[service];
          if (last && !last.ok) unreadable = true;
          perService[service] = last ? { enabled: true, ok: last.ok, live: false, at: last.at, ...(last.code ? { code: last.code } : {}) } : { enabled: true, ok: null, live: false, note: 'no sync has recorded a probe yet' };
        }
      }
      let held = 0;
      try { held = (await readAllSourceHolds(engine, { sourceIds: [s.id] }))[0]?.held.length ?? 0; } catch { held = -1; }
      report.push({ id: s.id, account: s.cfg.account, dir: s.cfg.dir, services: perService, last_sync_at: s.last_sync_at ? new Date(s.last_sync_at as string).toISOString() : null, held_items: held });
    }
    const first = report[0]!;
    emitEnvelope(out, {
      ok: !unreadable, status: unreadable ? 'degraded' : 'ok', sources: report,
      next: unreadable ? { command: 'gbrain apple setup', user_message: 'An enabled Apple service is unreadable; setup prints the exact System Settings pane to fix.' }
        : googleOnly ? { command: GOOGLE_SETUP_COMMAND, user_message: 'Every enabled Mail account is Google-hosted, so Apple Mail reads nothing; connect that mail through the Google connector.' }
          : { command: `gbrain sync --source ${String(first.id)}` },
    }, report.flatMap((r) => {
      const svc = r.services as Record<string, { enabled: boolean; ok?: boolean | null; code?: string; fix?: string; routing?: { status: string; apple_accounts: number; google_accounts_excluded: number } }>;
      return [
        `${String(r.id)}  account=${String(r.account)}  last sync: ${String(r.last_sync_at ?? 'never')}  held items: ${String(r.held_items)}`,
        ...ALL_APPLE_SERVICES.map((name) => {
          const v = svc[name]!;
          const state = !v.enabled ? 'disabled' : v.ok === true ? 'readable' : v.ok === false ? `UNREADABLE (${v.code})` : 'not yet probed';
          const route = v.routing ? `\n    accounts: ${v.routing.apple_accounts} read here, ${v.routing.google_accounts_excluded} Google-hosted excluded (read only via ${GOOGLE_SETUP_COMMAND})${v.routing.status === 'google_only' ? '; Apple Mail reads nothing' : ''}` : '';
          return `  ${name}: ${state}${v.ok === false && v.fix ? `\n    fix: ${v.fix}` : ''}${route}`;
        }),
      ];
    }));
    return unreadable ? 1 : 0;
  } finally {
    await handle.close();
  }
}

function pick(g: PermissionGuide): Record<string, unknown> {
  return { pane: g.pane, app: g.app };
}

// ── services ─────────────────────────────────────────────────────────────────

async function runServices(f: Flags, deps: AppleCommandDeps, out: AppleOut): Promise<number> {
  const handle = await openEngine(deps);
  const fail = (e: ReturnType<typeof errorEnvelope>): number => { emitEnvelope(out, e.envelope, e.human); return 1; };
  if (!handle) {
    return fail(errorEnvelope('no_brain', 'No gbrain brain is configured yet.', 'There is no Apple source to list.', 'Run `gbrain init`, then `gbrain apple setup`.', { command: 'gbrain init' }));
  }
  try {
    const sources = await listAppleSources(handle.engine);
    const wanted = f.positionals[0] ?? f.source;
    const source = wanted ? sources.find((s) => s.id === wanted) : sources.length === 1 ? sources[0] : undefined;
    if (!source) {
      if (wanted) {
        const [other] = await handle.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id=$1 AND archived IS NOT TRUE', [wanted]);
        return fail(other
          ? errorEnvelope('not_apple_source', `Source "${wanted}" is not an Apple source.`, 'Only an Apple source has per-service settings.', 'List sources and their kind with: gbrain sources list')
          : errorEnvelope('source_not_found', `Source "${wanted}" not found.`, 'No active source has that id.', 'List sources with: gbrain sources list'));
      }
      return sources.length === 0
        ? fail(errorEnvelope('source_not_found', 'No Apple source is registered.', 'Nothing to list.', 'Register one with: gbrain apple setup', { command: 'gbrain apple setup' }))
        : fail(errorEnvelope('ambiguous_source', `${sources.length} Apple sources are registered.`, 'Name the one you mean.', `gbrain apple services <source>  (one of: ${sources.map((s) => s.id).join(', ')})`));
    }
    const services = ALL_APPLE_SERVICES.map((name) => ({ service: name, enabled: source.cfg.services.includes(name) }));
    emitEnvelope(out, {
      ok: true, status: 'ok', source_id: source.id, account: source.cfg.account, services,
      next: { command: `gbrain sources set-services ${source.id} --add|--remove <service>`, user_message: 'Disabling a service stops syncing it; pages already imported stay.' },
    }, [
      `Source ${source.id} (account ${source.cfg.account}):`,
      ...services.map((s) => `  ${s.service}: ${s.enabled ? 'enabled' : 'disabled'}`),
      `Change: gbrain sources set-services ${source.id} --add|--remove <service>  (pages already imported stay)`,
    ]);
    return 0;
  } finally {
    await handle.close();
  }
}

// ── loops ────────────────────────────────────────────────────────────────────

/** Show or change the Mail open-loop settings of an Apple source. Writes config only; no Apple data is read and no model is called. */
async function runLoops(f: Flags, deps: AppleCommandDeps, out: AppleOut): Promise<number> {
  const handle = await openEngine(deps);
  if (!handle) return emitFail(out, errorEnvelope('no_brain', 'No gbrain brain is configured yet.', 'There is no Apple source to configure.', 'Run `gbrain init`, then `gbrain apple setup`.'), 1);
  try {
    const sources = await listAppleSources(handle.engine);
    const src = f.source ? sources.find((s) => s.id === f.source) : sources.length === 1 ? sources[0] : undefined;
    if (!src) {
      return emitFail(out, errorEnvelope('source_not_found', f.source ? `Apple source "${f.source}" not found.` : 'Pass --source <id>: there is not exactly one Apple source.',
        `Apple sources: ${sources.map((s) => s.id).join(', ') || 'none'}.`, 'Run `gbrain apple status`.'), 2);
    }
    if (f.consentExtraction && f.revokeExtraction) {
      return emitFail(out, errorEnvelope('invalid_value', 'Choose one of --consent-loops-extraction and --revoke-loops-extraction.', 'They contradict each other.', 'Pass only one.'), 1);
    }
    const patch: Record<string, unknown> = {};
    const next = { ...src.cfg };
    const ownersRaw = f.extra['--mail-owner-addresses'];
    if (ownersRaw !== undefined) {
      try {
        next.mailOwnerAddresses = buildAppleAddOptions({ services: 'calendar', mailOwnerAddresses: ownersRaw, dir: src.cfg.dir }).mailOwnerAddresses ?? [];
      } catch (error) {
        if (error instanceof AppleAddFlagError) return emitFail(out, errorEnvelope(error.code, error.message, 'The owner identity decides message direction; a bad value is never guessed around.', error.suggestion), 1);
        throw error;
      }
      patch.a_mail_owner_addresses = next.mailOwnerAddresses.join(',');
    }
    if (f.consentExtraction) {
      if (!next.services.includes('mail')) return emitFail(out, errorEnvelope('invalid_value', 'This source does not include Mail.', 'Extraction consent applies to Mail threads.', `Run gbrain sources set-services ${src.id} --add mail --confirm-mail first.`), 1);
      if (next.mailOwnerAddresses.length === 0) return emitFail(out, errorEnvelope('extraction_consent_requires_identity', 'Extraction consent needs --mail-owner-addresses.', 'Without the owner identity no thread is judged.', 'Pass --mail-owner-addresses together with --consent-loops-extraction.'), 1);
      patch.a_loops_extract_consent = true;
      next.loopsExtractConsent = true;
    }
    if (f.revokeExtraction) { patch.a_loops_extract_consent = false; next.loopsExtractConsent = false; }
    if (Object.keys(patch).length > 0) await handle.engine.updateSourceConfig(src.id, patch);
    const availability = appleLoopsAvailability(next);
    emitEnvelope(out, { ok: true, status: 'ok', source_id: src.id, changed: Object.keys(patch).length > 0,
      loops: { available: availability.available, ...(availability.available ? { extraction: availability.extraction === 'enabled' ? 'consented' : 'consent_missing' } : { unavailable: availability.reason }), owner_addresses: next.mailOwnerAddresses.length },
      next: { user_message: availability.available ? `Mail loop tracking is on for ${src.id}. Sync to refresh: gbrain sync --source ${src.id}` : `Mail loop tracking is unavailable for ${src.id}: ${availability.reason}. This is not \"clean\"; set --mail-owner-addresses.` } },
    [`Source ${src.id}: unanswered-mail tracking ${availability.available ? 'on' : `unavailable (${availability.reason})`}; extraction ${availability.available && availability.extraction === 'enabled' ? 'consented' : 'not consented'}; owners ${next.mailOwnerAddresses.length}.`,
      ...(f.consentExtraction ? [APPLE_LOOPS_EXTRACT_DISCLOSURE] : []),
      ...(Object.keys(patch).length > 0 ? [`Run: gbrain sync --source ${src.id}`] : [])]);
    return availability.available || Object.keys(patch).length === 0 ? 0 : 2;
  } finally {
    await handle.close();
  }
}

function emitFail(out: AppleOut, e: ReturnType<typeof errorEnvelope>, code: number): number {
  emitEnvelope(out, e.envelope, e.human);
  return code;
}

// ── entry ────────────────────────────────────────────────────────────────────

/** Returns the exit code: 0 done, 1 failed, 2 waiting on the user. */
export async function runApple(args: string[], deps: AppleCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    write(APPLE_HELP + '\n');
    return 0;
  }
  const parsed = parseFlags(rest);
  const json = rest.includes('--json');
  const out: AppleOut = { json, write };
  if ('error' in parsed) {
    const e = errorEnvelope('invalid_value', parsed.error, 'The arguments could not be parsed.', 'Run `gbrain apple --help` for the options.');
    emitEnvelope(out, e.envelope, e.human);
    return 1;
  }
  if (sub === 'setup') return runSetup(parsed, deps, out);
  if (sub === 'status') return runStatus(parsed, deps, out);
  if (sub === 'services') return runServices(parsed, deps, out);
  if (sub === 'loops') return runLoops(parsed, deps, out);
  const e = errorEnvelope('unknown_subcommand', `Unknown subcommand: ${sub}.`, 'gbrain apple has setup, status, services and loops.', 'Run `gbrain apple --help`.');
  emitEnvelope(out, e.envelope, e.human);
  return 2;
}
