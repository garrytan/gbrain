/**
 * gbrain google — connect/status/calendars/disconnect (+ setup, wired after
 * the source kind lands) for the Google connector.
 *
 * Agent-first contract (docs/guides/google-connect.md):
 *  - Every subcommand supports --json and emits the envelope
 *    { ok, status, next_action?: { command?, user_message? }, error? }.
 *  - Human output that the harness should relay verbatim is fenced in
 *    [SHOW USER] ... [/SHOW USER] blocks.
 *  - Secrets never travel via argv strings the shell history would keep:
 *    intake is --client-json <path|-> (preferred), env GOOGLE_CLIENT_ID/
 *    GOOGLE_CLIENT_SECRET, or a TTY prompt. --client-id/--client-secret are
 *    accepted for agent-driven non-TTY flows but documented as last resort.
 *  - Idempotent state machine: connect detects what already exists (client
 *    creds? account tokens?) and performs only the missing step. Re-running
 *    is always safe and is the documented fix for most errors.
 *
 * Engine-free: everything here reads/writes the credential vault. The
 * `status` subcommand best-effort connects an engine only to list linked
 * sources, and degrades without one.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { CredentialError, isCredentialError } from '../core/creds/errors.ts';
import {
  credentialId,
  openVault,
  type CredentialEntry,
  type CredentialVault,
} from '../core/creds/vault.ts';
import {
  GOOGLE_PROVIDER,
  GoogleTokenProvider,
  apiEnableLink,
  buildAuthUrl,
  exchangeCode,
  fetchSendAsAliases,
  fetchUserinfoEmail,
  generatePkce,
  parseClientJson,
  scopesForServices,
  validateClientPair,
} from '../core/creds/providers/google.ts';
import {
  PASTE_REDIRECT_URI,
  openBrowser,
  parsePastedRedirect,
  sniffHeadless,
  startLoopback,
} from '../core/creds/redirect.ts';
import { createSession, pollClaim, relayUrl } from '../core/creds/relay-client.ts';
import { gbrainPath } from '../core/config.ts';
import { deriveSourceId } from '../core/google/types.ts';
import { readLineSafe } from './init.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

// ── Shared bits ──────────────────────────────────────────────────────────────

import { ALL_GOOGLE_SERVICES, type GoogleService } from '../core/google/types.ts';

export const GOOGLE_SERVICES = ALL_GOOGLE_SERVICES;
export type { GoogleService };

export function parseServicesCsv(csv: string): GoogleService[] {
  const parts = csv
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = parts.filter((p) => !GOOGLE_SERVICES.includes(p as GoogleService));
  if (bad.length > 0) {
    throw new Error(`Unknown Google service(s): ${bad.join(', ')}. Valid: ${GOOGLE_SERVICES.join(', ')}`);
  }
  const uniq = [...new Set(parts)] as GoogleService[];
  return uniq.length > 0 ? uniq : [...GOOGLE_SERVICES];
}

interface JsonEnvelope {
  ok: boolean;
  status: string;
  next_action?: { command?: string; user_message?: string };
  error?: { code: string; problem: string; cause: string; fix: string; doc_url: string };
  [k: string]: unknown;
}

function emit(json: boolean, envelope: JsonEnvelope, humanLines: string[]): void {
  if (json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stdout.write(humanLines.join('\n') + '\n');
  }
}

/** Funnel events (local-only) — same JSONL shape gbrain integrations reads. */
export function appendGoogleHeartbeat(
  event: string,
  status: 'ok' | 'error',
  details?: Record<string, unknown>,
): void {
  try {
    const dir = gbrainPath('integrations', 'google');
    mkdirSync(dir, { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      event,
      status,
      ...(details ? { details } : {}),
    };
    appendFileSync(`${dir}/heartbeat.jsonl`, JSON.stringify(row) + '\n', 'utf-8');
  } catch {
    /* telemetry is never fatal */
  }
}

// ── The GCP checklist ([SHOW USER] block the harness relays verbatim) ───────

export function gcpChecklistBlock(): string {
  return [
    '[SHOW USER]',
    'Connect Google to gbrain — one-time setup (about 7 minutes, all in your browser).',
    '',
    'First, which kind of account is this?',
    '  - Google Workspace (your own domain) → in step 3 choose user type "Internal".',
    '  - Personal gmail.com → in step 3 choose "External" and do BOTH sub-steps.',
    '',
    '1. Create (or pick) a Google Cloud project: https://console.cloud.google.com/projectcreate',
    '2. Enable the three APIs (one click each):',
    '   - Gmail:    https://console.cloud.google.com/apis/library/gmail.googleapis.com',
    '   - Calendar: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
    '   - Contacts: https://console.cloud.google.com/apis/library/people.googleapis.com',
    '3. Configure the consent screen: https://console.cloud.google.com/auth/overview',
    '   - App name "gbrain", your email for both contact fields.',
    '   - Workspace → user type "Internal" (no verification, tokens never expire weekly).',
    '   - Personal gmail.com → user type "External", then:',
    '     a. add your own email as a Test user: https://console.cloud.google.com/auth/audience',
    '     b. on that same Audience page, click "Publish app" — skipping this makes',
    '        Google silently kill your access every 7 days.',
    '4. Create the OAuth client: https://console.cloud.google.com/auth/clients',
    '   - Application type: "Desktop app" (NOT "Web application" — this matters).',
    '5. Click "Download JSON" on the new client and hand the file back here.',
    '',
    'Heads up for the next step: Google will show "Google hasn\'t verified this app."',
    'That is YOUR app — click Advanced → Continue.',
    '[/SHOW USER]',
    '',
    'Then run:  gbrain google connect --client-json <path-to-downloaded-json>',
    '(or paste the JSON contents via stdin:  gbrain google connect --client-json -)',
  ].join('\n');
}

function consentBlock(url: string, mode: 'loopback' | 'paste', accountHint?: string): string {
  const after =
    mode === 'loopback'
      ? 'After approving, the browser shows "Connected" and this command finishes on its own.'
      : 'After approving, the browser will FAIL to load a http://127.0.0.1 page — that is expected.\nCopy that page\'s FULL address-bar URL and paste it back here.';
  return [
    '[SHOW USER]',
    `Open this link${accountHint ? ` with ${accountHint}` : ''} and approve access:`,
    '',
    `  ${url}`,
    '',
    'You may see "Google hasn\'t verified this app" — it\'s your own app: Advanced → Continue.',
    after,
    '[/SHOW USER]',
  ].join('\n');
}

// ── Pending two-step state (non-TTY paste flow across two invocations) ──────

interface PendingConnect {
  state: string;
  verifier: string;
  redirect_uri: string;
  scopes: string[];
  client_id: string;
  account_hint?: string;
  created_at: string;
}

function pendingPath(): string {
  return gbrainPath('google-connect-pending.json');
}

const PENDING_TTL_MS = 10 * 60_000;

function writePending(p: PendingConnect): void {
  mkdirSync(gbrainPath(), { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(p, null, 2), { mode: 0o600 });
}

function readPending(): PendingConnect | null {
  try {
    if (!existsSync(pendingPath())) return null;
    const p = JSON.parse(readFileSync(pendingPath(), 'utf-8')) as PendingConnect;
    // A corrupt created_at parses to NaN; `NaN > TTL` is false, which would
    // make the pending record immortal. Non-finite age = expired.
    const age = Date.now() - Date.parse(p.created_at);
    if (!Number.isFinite(age) || age > PENDING_TTL_MS) {
      rmSync(pendingPath(), { force: true });
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function clearPending(): void {
  rmSync(pendingPath(), { force: true });
}

// ── Flag parsing ─────────────────────────────────────────────────────────────

interface ConnectFlags {
  clientJson?: string;
  clientId?: string;
  clientSecret?: string;
  account?: string;
  reauth?: string | true;
  noBrowser: boolean;
  paste: boolean;
  code?: string;
  port?: number;
  services: GoogleService[];
  json: boolean;
  via?: string;
  timeoutMs: number;
  consentState?: 'production' | 'testing';
}

function parseConnectFlags(args: string[]): ConnectFlags {
  const f: ConnectFlags = {
    noBrowser: false,
    paste: false,
    services: [...GOOGLE_SERVICES],
    json: false,
    timeoutMs: 600_000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--client-json') { f.clientJson = args[++i]; continue; }
    if (a === '--client-id') { f.clientId = args[++i]; continue; }
    if (a === '--client-secret') { f.clientSecret = args[++i]; continue; }
    if (a === '--account') { f.account = args[++i]?.toLowerCase(); continue; }
    if (a === '--reauth') {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) { f.reauth = next.toLowerCase(); i++; } else { f.reauth = true; }
      continue;
    }
    if (a === '--no-browser') { f.noBrowser = true; continue; }
    if (a === '--paste') { f.paste = true; continue; }
    if (a === '--code') { f.code = args[++i]; continue; }
    if (a === '--port') { f.port = Number(args[++i]); continue; }
    if (a === '--scopes' || a === '--services') { f.services = parseServicesCsv(args[++i] ?? ''); continue; }
    if (a === '--json') { f.json = true; continue; }
    if (a === '--via') { f.via = args[++i]; continue; }
    if (a === '--timeout-ms') { f.timeoutMs = Number(args[++i]) || 600_000; continue; }
    if (a === '--consent-state') {
      const v = args[++i];
      if (v === 'production' || v === 'testing') f.consentState = v;
      continue;
    }
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  }
  return f;
}

// ── connect ──────────────────────────────────────────────────────────────────

async function resolveClientCreds(
  vault: CredentialVault,
  f: ConnectFlags,
): Promise<{ client_id: string; client_secret: string } | null> {
  // 1. Explicit JSON file / stdin contents.
  if (f.clientJson) {
    let raw: string;
    if (f.clientJson === '-') {
      raw = readFileSync(0, 'utf-8');
    } else {
      try {
        raw = readFileSync(f.clientJson, 'utf-8');
      } catch (e) {
        throw new CredentialError('client_json_unreadable', undefined, e);
      }
    }
    return parseClientJson(raw);
  }
  // 2. Explicit pair (agent-driven non-TTY flows).
  if (f.clientId && f.clientSecret) return validateClientPair(f.clientId, f.clientSecret);
  // 3. Environment (same names integrations' secretEnv() folds).
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return validateClientPair(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  }
  // 4. Already on file.
  const existing = await vault.getClient(GOOGLE_PROVIDER);
  if (existing) return { client_id: existing.client_id, client_secret: existing.client_secret };
  // 5. TTY prompt (readLineSafe returns '' immediately on non-TTY).
  const pastedId = await readLineSafe('Google OAuth client ID (or Enter to see setup steps): ', '', 120_000);
  if (pastedId.trim() !== '') {
    const pastedSecret = await readLineSafe('Client secret: ', '', 120_000);
    return validateClientPair(pastedId, pastedSecret);
  }
  return null;
}

async function finishConnect(
  vault: CredentialVault,
  f: ConnectFlags,
  tokens: { access_token: string; refresh_token?: string; expires_in: number; scope?: string },
  clientId: string | undefined,
  clientRef: 'byo' | 'hosted-relay',
  fetchImpl: typeof fetch,
  knownEmail?: string,
  scopesOverride?: string[],
): Promise<CredentialEntry> {
  const email = knownEmail ?? (await fetchUserinfoEmail(tokens.access_token, fetchImpl));
  if (f.account && email !== f.account) {
    // handleCredError is the single connect_error funnel emission point.
    throw new CredentialError('wrong_account_consented', undefined, `consented: ${email}`);
  }
  const sendasAliases = await fetchSendAsAliases(tokens.access_token, fetchImpl);
  const nowIso = new Date().toISOString();
  const prior = await vault.get(credentialId(GOOGLE_PROVIDER, email));
  const entry: CredentialEntry = {
    id: credentialId(GOOGLE_PROVIDER, email),
    provider: GOOGLE_PROVIDER,
    kind: 'oauth2',
    client_ref: clientRef,
    secret: {
      access_token: tokens.access_token,
      expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      ...(tokens.refresh_token
        ? { refresh_token: tokens.refresh_token }
        : prior?.secret.refresh_token
          ? { refresh_token: prior.secret.refresh_token }
          : {}),
    },
    meta: {
      account: email,
      // The token response's `scope` is what Google ACTUALLY granted — the
      // consent screen lets users uncheck scopes, so the requested set is a
      // fallback, never the truth. Persisting the grant is what lets the
      // sync preflight say `scope_missing` instead of opaque per-sweep 403s.
      scopes: (() => {
        const granted = tokens.scope?.split(/\s+/).filter(Boolean);
        return granted && granted.length > 0
          ? granted
          : (scopesOverride ?? scopesForServices(f.services));
      })(),
      ...(clientId ? { client_id: clientId } : {}),
      connected_at: prior?.meta.connected_at ?? nowIso,
      last_refresh_ok_at: nowIso,
      ...(sendasAliases.length > 0 ? { sendas_aliases: sendasAliases } : {}),
      consent_publish_state: f.consentState ?? prior?.meta.consent_publish_state ?? 'unknown',
    },
  };
  await vault.put(entry);
  appendGoogleHeartbeat('consent_ok', 'ok', { account_hash: hashish(email), client_ref: clientRef });
  return entry;
}

/** Non-reversible short tag so heartbeats never carry the raw address. */
function hashish(email: string): string {
  let h = 0;
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).slice(0, 8);
}

export async function runGoogleConnect(args: string[]): Promise<void> {
  const f = parseConnectFlags(args);
  const vault = openVault();
  const fetchImpl = fetch;
  appendGoogleHeartbeat('connect_started', 'ok');

  try {
    // Relay fast path (hosted verified client; tokens still stored locally).
    if (f.via) {
      // Token custody rides this URL: whatever host it names brokers the
      // consent AND receives the claim. https only, and the 'gbrain.io'
      // shorthand resolves exclusively through the GBRAIN_OAUTH_RELAY_URL
      // feature gate — no hardcoded default that could go live by surprise.
      const base = f.via === 'gbrain.io' ? relayUrl() : f.via.replace(/\/+$/, '');
      if (!base) throw new CredentialError('relay_disabled');
      if (!/^https:\/\//i.test(base)) {
        throw new CredentialError('relay_unreachable', undefined, `refusing non-https relay base: ${base}`);
      }
      const session = await createSession(
        base,
        { provider: 'google', scopes: scopesForServices(f.services), client_kind: 'cli' },
        fetchImpl,
      );
      process.stderr.write(consentBlock(session.consent_url, 'loopback', f.account) + '\n');
      if (!f.noBrowser && !sniffHeadless()) openBrowser(session.consent_url);
      const claim = await pollClaim(base, session, { timeoutMs: f.timeoutMs }, fetchImpl);
      // Malformed relay expiry parses to NaN, which Math.max propagates and
      // Date#toISOString later throws on — clamp to a safe default instead.
      const expMs = Date.parse(claim.expiry);
      const entry = await finishConnect(
        vault,
        f,
        {
          access_token: claim.access_token,
          refresh_token: claim.refresh_token,
          expires_in: Number.isFinite(expMs)
            ? Math.max(60, Math.round((expMs - Date.now()) / 1000))
            : 3600,
          ...(claim.scopes.length > 0 ? { scope: claim.scopes.join(' ') } : {}),
        },
        undefined,
        'hosted-relay',
        fetchImpl,
        claim.email,
      );
      printConnected(f.json, entry);
      return;
    }

    // Two-step completion: a prior invocation printed the consent URL and
    // stored the PKCE state; this one carries the pasted redirect.
    if (f.code) {
      const pending = readPending();
      if (!pending) throw new CredentialError('consent_timeout');
      const client = await vault.getClient(GOOGLE_PROVIDER);
      if (!client) throw new CredentialError('not_connected', ' (no OAuth client on file)');
      const parsed = parsePastedRedirect(f.code, pending.state);
      const tokens = await exchangeCode(
        {
          clientId: client.client_id,
          clientSecret: client.client_secret,
          code: parsed.code,
          redirectUri: pending.redirect_uri,
          codeVerifier: pending.verifier,
        },
        fetchImpl,
      );
      // Step 1's --account/--reauth binding must survive into this
      // invocation — the printed next_action doesn't carry --account, so a
      // wrong-account consent in the two-step flow would otherwise pass
      // finishConnect's identity check unexamined.
      const fBound = !f.account && pending.account_hint ? { ...f, account: pending.account_hint } : f;
      const entry = await finishConnect(
        vault, fBound, tokens, client.client_id, 'byo', fetchImpl,
        undefined,
        // Step 1's (possibly narrowed) scope request is the fallback when the
        // token response carries no `scope`; never this invocation's default
        // f.services.
        pending.scopes,
      );
      // Only the flow that CONSUMED the pending record clears it — a
      // parallel loopback/relay connect completing must not delete an
      // unrelated in-flight paste flow's state.
      clearPending();
      printConnected(f.json, entry);
      return;
    }

    // Client credentials — resolve or hand back the checklist.
    const creds = await resolveClientCreds(vault, f);
    if (!creds) {
      const checklist = gcpChecklistBlock();
      emit(
        f.json,
        {
          ok: false,
          status: 'needs_client_credentials',
          next_action: {
            command: 'gbrain google connect --client-json <path>',
            user_message: checklist,
          },
        },
        [checklist],
      );
      setCliExitVerdict(2);
      return;
    }
    // Refresh tokens are bound to the client that minted them: silently
    // replacing the stored client (stale env vars suffice) breaks every
    // sibling account's refresh with a misleading "revoked" diagnosis.
    // Warn loudly; proceeding is still legal (BYO users rotate clients).
    const priorClient = await vault.getClient(GOOGLE_PROVIDER);
    if (priorClient && priorClient.client_id !== creds.client_id) {
      const accounts = await vault.list({ provider: GOOGLE_PROVIDER });
      if (accounts.length > 0) {
        process.stderr.write(
          `[google] warning: replacing the stored OAuth client (${priorClient.client_id.slice(0, 12)}…) ` +
            `with a different one. Refresh tokens are client-bound — if refresh starts failing for the ` +
            `${accounts.length} already-connected account(s), run \`gbrain google connect --reauth <email>\`.\n`,
        );
      }
    }
    await vault.putClient({
      provider: GOOGLE_PROVIDER,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      created_at: new Date().toISOString(),
    });
    appendGoogleHeartbeat('client_creds_ok', 'ok');

    const accountHint =
      typeof f.reauth === 'string' ? f.reauth : (f.account ?? undefined);
    const pkce = generatePkce();
    const state = randomBytes(16).toString('hex');
    const usePaste = f.paste || sniffHeadless();

    if (usePaste) {
      const url = buildAuthUrl({
        clientId: creds.client_id,
        redirectUri: PASTE_REDIRECT_URI,
        scopes: scopesForServices(f.services),
        state,
        codeChallenge: pkce.challenge,
        ...(accountHint ? { loginHint: accountHint } : {}),
      });
      writePending({
        state,
        verifier: pkce.verifier,
        redirect_uri: PASTE_REDIRECT_URI,
        scopes: scopesForServices(f.services),
        client_id: creds.client_id,
        ...(accountHint ? { account_hint: accountHint } : {}),
        created_at: new Date().toISOString(),
      });
      const block = consentBlock(url, 'paste', accountHint);
      if (process.stdin.isTTY) {
        process.stderr.write(block + '\n');
        const pasted = await readLineSafe('Paste the full redirect URL here: ', '', f.timeoutMs);
        if (pasted.trim() === '') throw new CredentialError('consent_timeout');
        const parsed = parsePastedRedirect(pasted, state);
        const tokens = await exchangeCode(
          {
            clientId: creds.client_id,
            clientSecret: creds.client_secret,
            code: parsed.code,
            redirectUri: PASTE_REDIRECT_URI,
            codeVerifier: pkce.verifier,
          },
          fetchImpl,
        );
        const entry = await finishConnect(vault, f, tokens, creds.client_id, 'byo', fetchImpl);
        // The TTY paste consumed the pending record it wrote above; a FAILED
        // paste deliberately leaves it (recoverable via --code, same state).
        clearPending();
        printConnected(f.json, entry);
        return;
      }
      // Non-TTY: hand the URL to the harness; the user's paste comes back
      // via a second invocation with --code. Exactly one user interaction.
      emit(
        f.json,
        {
          ok: false,
          status: 'awaiting_consent',
          next_action: {
            command: 'gbrain google connect --code "<pasted-redirect-url>"',
            user_message: block,
          },
        },
        [block, '', 'Then run:  gbrain google connect --code "<pasted-redirect-url>"'],
      );
      setCliExitVerdict(2);
      return;
    }

    // Loopback (local TTY with a browser).
    const loop = startLoopback({ state, ...(f.port ? { port: f.port } : {}), timeoutMs: f.timeoutMs });
    try {
      const url = buildAuthUrl({
        clientId: creds.client_id,
        redirectUri: loop.redirectUri,
        scopes: scopesForServices(f.services),
        state,
        codeChallenge: pkce.challenge,
        ...(accountHint ? { loginHint: accountHint } : {}),
      });
      process.stderr.write(consentBlock(url, 'loopback', accountHint) + '\n');
      if (!f.noBrowser) openBrowser(url);
      const code = await loop.codePromise;
      const tokens = await exchangeCode(
        {
          clientId: creds.client_id,
          clientSecret: creds.client_secret,
          code,
          redirectUri: loop.redirectUri,
          codeVerifier: pkce.verifier,
        },
        fetchImpl,
      );
      const entry = await finishConnect(vault, f, tokens, creds.client_id, 'byo', fetchImpl);
      printConnected(f.json, entry);
    } finally {
      loop.close();
    }
  } catch (e) {
    handleCredError(e, f.json);
  }
}

function printConnected(json: boolean, entry: CredentialEntry): void {
  const email = entry.meta.account ?? entry.id;
  const suggestedId = deriveSourceId(email);
  const nextCmd = `gbrain sources add ${suggestedId} --kind google --account ${email}`;
  emit(
    json,
    {
      ok: true,
      status: 'connected',
      account: email,
      scopes: entry.meta.scopes ?? [],
      client_ref: entry.client_ref,
      next_action: {
        command: nextCmd,
        user_message: `Connected ${email}.`,
      },
    },
    [
      `Connected ${email} (${(entry.meta.scopes ?? []).length} scopes, ${entry.client_ref}).`,
      '',
      `Next: register it as a source and sync:`,
      `  ${nextCmd}`,
      `  gbrain sync --source ${suggestedId}`,
    ],
  );
}

function handleCredError(e: unknown, json: boolean): never {
  if (isCredentialError(e)) {
    appendGoogleHeartbeat('connect_error', 'error', { code: e.code });
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, status: 'error', error: e.toJSON() }, null, 2) + '\n',
      );
    } else {
      process.stderr.write(e.toHuman() + '\n');
    }
    process.exit(1);
  }
  throw e;
}

// ── status ───────────────────────────────────────────────────────────────────

export async function runGoogleStatus(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const probe = !args.includes('--no-probe');
  const vault = openVault();
  const metas = await vault.list({ provider: GOOGLE_PROVIDER });
  const client = await vault.getClient(GOOGLE_PROVIDER);

  const accounts: Array<Record<string, unknown>> = [];
  for (const m of metas) {
    const row: Record<string, unknown> = {
      account: m.account ?? m.id,
      client_ref: m.client_ref,
      scopes: m.scopes ?? [],
      connected_at: m.connected_at,
      last_refresh_ok_at: m.last_refresh_ok_at ?? null,
      access_token_expiry: m.expiry ?? null,
      sendas_aliases: m.sendas_aliases ?? [],
      consent_publish_state: m.consent_publish_state ?? 'unknown',
    };
    if (probe) {
      try {
        const provider = new GoogleTokenProvider(vault, m.id);
        await provider.forceRefresh();
        row.refresh_probe = 'ok';
      } catch (e) {
        row.refresh_probe = isCredentialError(e) ? e.code : 'error';
        row.refresh_error = isCredentialError(e) ? e.toJSON() : String(e);
      }
    }
    accounts.push(row);
  }

  // Linked sources: best-effort, engine optional.
  let linkedSources: Array<{ id: string; account: string | null }> = [];
  try {
    const { loadConfig, toEngineConfig } = await import('../core/config.ts');
    const cfg = loadConfig();
    if (cfg) {
      const { createEngine } = await import('../core/engine-factory.ts');
      const engineConfig = toEngineConfig(cfg);
      const engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
      try {
        const rows = await engine.executeRaw<{ id: string; config: unknown }>(
          `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
          [],
        );
        linkedSources = rows
          .map((r) => {
            const c =
              typeof r.config === 'string'
                ? (JSON.parse(r.config) as Record<string, unknown>)
                : ((r.config ?? {}) as Record<string, unknown>);
            return c.kind === 'google'
              ? { id: r.id, account: typeof c.g_account === 'string' ? c.g_account : null }
              : null;
          })
          .filter((x): x is { id: string; account: string | null } => x !== null);
      } finally {
        await engine.disconnect();
      }
    }
  } catch {
    /* no engine — vault-only status */
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          status: accounts.length > 0 ? 'connected' : 'not_connected',
          client_on_file: client !== null,
          accounts,
          linked_sources: linkedSources,
        },
        null,
        2,
      ) + '\n',
    );
    // Same exit semantics as the human path: not-connected is verdict 1 in
    // BOTH output modes, so agents branching on exit code get one answer.
    if (accounts.length === 0) setCliExitVerdict(1);
    return;
  }
  if (accounts.length === 0) {
    process.stdout.write(
      'No Google accounts connected. Run `gbrain google connect` to start.\n',
    );
    setCliExitVerdict(1);
    return;
  }
  for (const a of accounts) {
    const probeStr = 'refresh_probe' in a ? ` refresh=${String(a.refresh_probe)}` : '';
    process.stdout.write(
      `${String(a.account)}  [${String(a.client_ref)}]${probeStr}  scopes=${(a.scopes as string[]).length}  consent=${String(a.consent_publish_state)}\n`,
    );
    if (a.refresh_error) {
      const err = a.refresh_error as { fix?: string };
      if (err.fix) process.stdout.write(`  fix: ${err.fix}\n`);
    }
  }
  if (linkedSources.length > 0) {
    process.stdout.write(
      `Linked sources: ${linkedSources.map((s) => s.id).join(', ')}\n`,
    );
  } else {
    process.stdout.write('Linked sources: none yet — `gbrain sources add <id> --kind google --account <email>`\n');
  }
}

// ── disconnect ───────────────────────────────────────────────────────────────

export async function runGoogleDisconnect(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const purgeClient = args.includes('--purge-client');
  const email = args.find((a) => !a.startsWith('--'))?.toLowerCase();
  if (!email) {
    console.error('Usage: gbrain google disconnect <email> [--purge-client] [--json]');
    process.exit(2);
  }
  const vault = openVault();
  const deleted = await vault.delete(credentialId(GOOGLE_PROVIDER, email));
  if (purgeClient) await vault.deleteClient(GOOGLE_PROVIDER);
  emit(
    json,
    {
      ok: deleted,
      status: deleted ? 'disconnected' : 'not_found',
      next_action: {
        user_message: deleted
          ? `Disconnected ${email}. To also revoke gbrain's access on Google's side: https://myaccount.google.com/permissions`
          : `No connection found for ${email}.`,
      },
    },
    [
      deleted
        ? `Disconnected ${email}. Tokens removed locally.\nTo revoke on Google's side too: https://myaccount.google.com/permissions`
        : `No connection found for ${email}.`,
    ],
  );
  if (!deleted) setCliExitVerdict(1);
}

// ── entry ────────────────────────────────────────────────────────────────────

const HELP = `gbrain google — connect Google (Gmail, Calendar, Contacts) to your brain

Subcommands:
  connect      Connect a Google account (guided; BYO OAuth client)
               --client-json <path|->   downloaded client_secret*.json (or '-' for stdin)
               --client-id / --client-secret   explicit pair (agents; prefer --client-json)
               --account <email>        expected account (verified after consent)
               --reauth [email]         re-run consent for an existing account
               --scopes gmail,calendar,contacts   narrower scope set (default: all)
               --paste                  headless flow (paste the redirect URL back)
               --code "<redirect-url>"  complete a pending --paste flow
               --no-browser             never try to open a browser
               --port <n>               fixed loopback port
               --via gbrain.io          hosted fast path (no GCP setup; feature-gated)
               --consent-state production|testing   record your consent screen's state
               --timeout-ms <ms>        consent wait timeout (default 600000)
               --json
  setup        connect + register source + first sync + first 'waiting' (one command)
               --account <email>        which account (repeat setup per account)
               --history-days <n>       backfill window for the source (default 90)
               --sync-budget-ms <ms>    first-sync wall-clock budget
               (+ all connect flags above)
  status       accounts, scopes, refresh probe, linked sources  [--json] [--no-probe]
  calendars    list every calendar the account can read (ids for --calendar-id)
               [--account <email>] [--json]
  disconnect   remove an account's tokens  <email> [--purge-client]

Docs: docs/guides/google-connect.md`;

/**
 * `gbrain google calendars [--account <email>] [--json]`
 * Lists every calendar the connected account can read, so a secondary
 * calendar's id can be handed to `sources add --calendar-id`. Read-only.
 * `--json` emits the shared envelope (`ok`, `status`, `next_action.command`
 * = the `sources add` template) plus `account` and `calendars[]`.
 */
export async function runGoogleCalendars(args: string[]): Promise<void> {
  let account = '';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account') account = (args[++i] ?? '').trim().toLowerCase();
    else if (args[i] === '--json') json = true;
  }
  const vault = openVault();
  if (!account) {
    const ids = await vault.list();
    const g = ids.filter((e) => e.provider === GOOGLE_PROVIDER);
    if (g.length === 0) {
      console.error('No connected Google account — run: gbrain google connect');
      process.exit(2);
    }
    if (g.length > 1) {
      console.error(
        `Multiple Google accounts connected — pass --account <email> (one of: ${g
          .map((e) => String(e.account ?? e.id))
          .join(', ')}).`,
      );
      process.exit(2);
    }
    account = String(g[0].account ?? g[0].id.replace(/^google:/, ''));
  }
  const entry = await vault.get(credentialId(GOOGLE_PROVIDER, account));
  if (!entry) {
    throw new CredentialError('not_connected', ` for ${account} — run: gbrain google connect --account ${account}`);
  }
  const tokens = new GoogleTokenProvider(vault, entry.id, fetch);
  const { CalendarClient } = await import('../core/google/google-clients.ts');
  const client = new CalendarClient(tokens, fetch, () => {}, entry.meta.client_id);
  const cals = await client.listCalendars();
  const addCommand = `gbrain sources add <id> --kind google --account ${account} --services calendar --calendar-id "<id>"`;
  emit(
    json,
    { ok: true, status: 'ok', account, calendars: cals, next_action: { command: addCommand } },
    [
      `Calendars readable by ${account}:\n`,
      ...cals.map(
        (c) => `  ${c.primary ? '*' : ' '} ${c.summary}\n      id: ${c.id}\n      access: ${c.accessRole}`,
      ),
      `\n(* = primary, already synced). To ingest another:\n  ${addCommand}`,
    ],
  );
}

export async function runGoogle(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (sub === 'connect') return runGoogleConnect(rest);
  if (sub === 'status') return runGoogleStatus(rest);
  if (sub === 'calendars') return runGoogleCalendars(rest);
  if (sub === 'disconnect') return runGoogleDisconnect(rest);
  if (sub === 'setup') {
    const { runGoogleSetup } = await import('./google-setup.ts');
    return runGoogleSetup(rest);
  }
  console.error(`Unknown subcommand: ${sub}\n`);
  process.stdout.write(HELP + '\n');
  process.exit(2);
}
