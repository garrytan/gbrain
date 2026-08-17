/**
 * gbrain agent register — mint a scoped OAuth client + access token and print
 * the exact MCP wiring for a harness (cathedral-6, spec PR-6 "shared brain").
 *
 * CLI-ONLY, never an MCP op. Composes existing parts — registerScopedClient
 * (auth.ts peel), exchangeClientCredentials, the mcp-registration argv
 * builders, renderCodexHttpServerBlock, openclawThinClientBlock — it builds
 * no new auth machinery.
 *
 *   register flow (order is load-bearing):
 *     [cli.ts pre-connect guards: thin client refusal + PGLite live-serve]
 *       → parse (pure, exit 2)  → preset resolve (pure)
 *       → validate sources (existence + archived, engine lane)
 *       → column PRE-FLIGHT (outside any tx — 25P02 forbids in-tx degrade)
 *       → ONE engine.transaction:
 *           name advisory lock → duplicate-name pre-check
 *           → ensureWorkspaceSource (create-or-clean-reuse, refuse dirty)
 *           → registerScopedClient (INSERT + ttl UPDATE + surface rescope)
 *       → COMMIT
 *       → audit (fail-open, designed post-commit position)
 *       → exchangeClientCredentials (outer engine — the tx sql is dead)
 *       → optional serve probe (--url/--port; note, never a failure)
 *       → render harness block → print (human) | single JSON doc
 *
 * Failure after COMMIT leaves a live client (and possibly a clean, empty
 * workspace source): we print the client_id + the exact revoke command —
 * never a false "nothing was created".
 */
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { sqlQueryForEngine, type SqlQuery } from '../core/sql-query.ts';
import { assertAllowedScopes } from '../core/scope.ts';
import { assertValidSourceId, ALL_SOURCES, SOURCE_ID_RE } from '../core/source-id.ts';
import { addSource } from '../core/sources-ops.ts';
import { loadAllSources } from '../core/sources-load.ts';
import { generateToken, hashToken } from '../core/utils.ts';
import {
  normalizeMcpUrl,
  issuerFromMcpUrl,
  isValidName,
  buildClaudeMcpAddArgv,
  buildCodexMcpAddArgv,
  buildOpencodeMcpAddArgv,
  cmdString,
  shellQuote,
  openclawThinClientBlock,
  OAUTH_SECRET_NOTE,
  REDACTED,
} from '../core/mcp-registration.ts';
import { GBRAIN_REMOTE_TOKEN_ENV } from '../core/bootstrap/opencode-json.ts';
import { renderCodexHttpServerBlock } from '../core/bootstrap/codex-toml.ts';
import { probeServeHealth, isServeOlderThanScopes, SCOPES_MIN_SERVE_VERSION } from '../core/bootstrap/serve-health.ts';
import { writeSurfaceChangeAudit } from '../core/surface-audit.ts';
import {
  registerScopedClient,
  preflightOauthClientColumns,
  parseRegisterClientArgs,
  parseTokenTtl,
  type RegisterClientArgs,
  type RegisteredClient,
} from './auth.ts';

// ── constants ─────────────────────────────────────────────────────────────

export const REGISTER_HARNESSES = ['claude-code', 'codex', 'opencode', 'openclaw'] as const;
export type RegisterHarness = (typeof REGISTER_HARNESSES)[number];
export const REGISTER_PRESETS = ['daily-driver', 'coding-agent'] as const;
export type RegisterPreset = (typeof REGISTER_PRESETS)[number];

/** Register ALWAYS writes token_ttl: the server default for CLI-minted access
 * tokens is 3600s — a printed "30-day" config with the default TTL would die
 * in an hour. 30 days, inside the auth.ts bounds. */
export const REGISTER_DEFAULT_TOKEN_TTL_SECONDS = 2_592_000;

/** Scopes an agent client may not hold — operators use auth register-client. */
const SCOPE_BLOCKLIST = new Set(['admin', 'sources_admin', 'users_admin', 'agent']);

/** Derived-workspace source suffix. Exported for the doctor
 * oauth_client_scope_health orphan heuristic (single source of truth). */
export const WORKSPACE_SUFFIX = '-workspace';
/** SOURCE_ID_RE caps ids at 32 chars; '-workspace' is 10. */
export const WORKSPACE_NAME_MAX = 22;

/** Advisory-lock key for name-scoped registration/rotation serialization.
 * Cross-process wire contract (pinned in test/lock-keys.test.ts) — every
 * writer hashing a different string holds a different lock. */
export function registerClientNameLockKey(name: string): string {
  return `register_client_name:${name}`;
}

/** The thin-client refusal, shared verbatim by the cli.ts pre-connect guard
 * and the in-handler belt-and-braces re-check. */
export const THIN_CLIENT_REGISTER_MESSAGE =
  '`gbrain agent register` mints credentials into the HOST brain — run it on the brain host (the machine that runs `gbrain serve --http`), then wire this machine with the printed `gbrain init --mcp-only …` block.';

export type RegisterFailReason =
  | 'invalid_argument'
  | 'unknown_source'
  | 'archived_source'
  | 'dirty_source'
  | 'duplicate_name'
  | 'thin_client'
  | 'pglite_live_serve'
  | 'reissue_invalid_target'
  | 'mint_failed'
  | 'brain_too_old'
  | 'serve_too_old'
  | 'internal';

export class RegisterError extends Error {
  constructor(
    public reason: RegisterFailReason,
    message: string,
    public clientId?: string,
  ) {
    super(message);
  }
}

// ── parsing (pure) ────────────────────────────────────────────────────────

export interface AgentRegisterArgs {
  name?: string;
  reissueClientId?: string;
  harness?: RegisterHarness;
  preset?: RegisterPreset;
  source?: string;
  federatedRead?: string[];
  scopes?: string;
  url?: string;
  port?: number;
  tokenTtlSeconds?: number;
  surface?: 'verbs' | 'starter' | 'full';
  showToken: boolean;
  json: boolean;
  /** Accept a PROVEN-too-old serve (< SCOPES_MIN_SERVE_VERSION verifies
   * scoped tokens as FULL ACCESS) instead of failing registration. */
  allowOldServe: boolean;
}

const REGISTER_USAGE =
  'Usage: gbrain agent register <name> --harness claude-code|codex|opencode|openclaw ' +
  '[--preset daily-driver|coding-agent] [--source ID] [--federated-read S1,S2] ' +
  '[--scopes "read write"] (--url URL | --port N) [--token-ttl SECONDS] ' +
  '[--surface verbs|starter|full] [--allow-old-serve] [--show-token] [--json]\n' +
  '       gbrain agent register --reissue <client-id> --harness H (--url URL | --port N) [--show-token] [--json]';

export function parseAgentRegisterArgs(args: string[]): AgentRegisterArgs {
  const out: AgentRegisterArgs = { showToken: false, json: false, allowOldServe: false };
  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    const value = args[i + 1];
    const requireValue = () => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    };
    if (!flag.startsWith('--')) {
      if (out.name !== undefined) throw new Error(`Unexpected argument: ${flag}`);
      out.name = flag;
      i += 1;
      continue;
    }
    switch (flag) {
      case '--reissue':
        out.reissueClientId = requireValue();
        i += 2; break;
      case '--harness': {
        const v = requireValue();
        if (!(REGISTER_HARNESSES as readonly string[]).includes(v)) {
          throw new Error(`--harness must be one of ${REGISTER_HARNESSES.join(' | ')} (got "${v}")`);
        }
        out.harness = v as RegisterHarness;
        i += 2; break;
      }
      case '--preset': {
        const v = requireValue();
        if (!(REGISTER_PRESETS as readonly string[]).includes(v)) {
          throw new Error(`--preset must be ${REGISTER_PRESETS.join(' | ')} (got "${v}")`);
        }
        out.preset = v as RegisterPreset;
        i += 2; break;
      }
      case '--source': {
        const v = requireValue();
        assertValidSourceId(v);
        out.source = v;
        i += 2; break;
      }
      case '--federated-read': {
        const v = requireValue();
        // Set-dedupe (order-preserving): a repeated id would otherwise fan
        // out twice in every downstream per-source loop.
        const ids = [...new Set(v.split(',').map(s => s.trim()).filter(Boolean))];
        if (ids.length === 0) throw new Error('--federated-read requires at least one source id');
        for (const id of ids) {
          if (id === ALL_SOURCES) {
            throw new Error('no wildcard read grant exists — list sources explicitly (__all__ is a trusted-local sentinel, never a grant)');
          }
          assertValidSourceId(id);
        }
        out.federatedRead = ids;
        i += 2; break;
      }
      case '--scopes': {
        // Tokenize exactly like auth.ts's register-client parser, then apply
        // the agent blocklist per-token, then the shared allowlist.
        const v = requireValue();
        const tokens = v.split(/[\s,]+/).filter(Boolean);
        if (tokens.length === 0) {
          throw new Error(`--scopes requires at least one scope (got ${JSON.stringify(v)})`);
        }
        for (const t of tokens) {
          if (SCOPE_BLOCKLIST.has(t)) {
            throw new Error(`scope "${t}" is not grantable to an agent client — use \`gbrain auth register-client\` for operator-grade scopes`);
          }
        }
        assertAllowedScopes(tokens);
        out.scopes = tokens.join(' ');
        i += 2; break;
      }
      case '--url':
        out.url = requireValue();
        i += 2; break;
      case '--port': {
        const raw = requireValue();
        const v = Number(raw);
        if (!Number.isInteger(v) || v < 1 || v > 65535) {
          throw new Error(`--port must be an integer between 1 and 65535 (got ${JSON.stringify(raw)})`);
        }
        out.port = v;
        i += 2; break;
      }
      case '--token-ttl': {
        out.tokenTtlSeconds = parseTokenTtl(requireValue(), 'Omit the flag for the 30-day default.');
        i += 2; break;
      }
      case '--surface': {
        const v = requireValue();
        if (v !== 'verbs' && v !== 'starter' && v !== 'full') {
          throw new Error(`--surface must be verbs | starter | full (got "${v}")`);
        }
        out.surface = v;
        i += 2; break;
      }
      case '--allow-old-serve': out.allowOldServe = true; i += 1; break;
      case '--show-token': out.showToken = true; i += 1; break;
      case '--json': out.json = true; i += 1; break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  if (out.reissueClientId !== undefined) {
    if (out.name !== undefined) throw new Error('--reissue takes a client-id, not a name');
    if (out.preset || out.source || out.federatedRead || out.scopes || out.surface || out.tokenTtlSeconds !== undefined) {
      throw new Error('--reissue only rotates the secret and reprints the block — scope flags are not allowed (use `gbrain auth rescope-client` to change scope)');
    }
  } else {
    if (!out.name) throw new Error(`agent register requires a <name>.\n${REGISTER_USAGE}`);
    if (!isValidName(out.name)) {
      throw new Error(`invalid name "${out.name}" — lowercase letters, digits, - and _ only (it becomes the MCP server name)`);
    }
  }
  if (!out.harness) throw new Error(`--harness is required.\n${REGISTER_USAGE}`);
  if (out.url !== undefined && out.port !== undefined) {
    throw new Error('pass --url OR --port, not both');
  }
  return out;
}

// ── preset resolution (pure descriptor; snapshot resolved by the runner) ──

export interface ResolvedPreset {
  scopes: string;
  writeSource: string;
  /** 'snapshot' = all non-archived sources at registration time. */
  federatedRead: string[] | 'snapshot';
  surface?: 'verbs' | 'starter' | 'full';
  /** The write source is the derived `<name>-workspace` (auto-creatable). */
  workspaceDerived: boolean;
}

export function resolvePreset(flags: AgentRegisterArgs): ResolvedPreset {
  const name = flags.name ?? '';
  const explicit = <T>(v: T | undefined, fallback: T): T => (v !== undefined ? v : fallback);
  switch (flags.preset) {
    case 'daily-driver':
      return {
        scopes: explicit(flags.scopes, 'read write'),
        writeSource: explicit(flags.source, 'default'),
        federatedRead: flags.federatedRead ?? 'snapshot',
        // starter is literally "the ~20-op daily-driver set" (mcp/surface.ts).
        surface: explicit(flags.surface, 'starter'),
        workspaceDerived: false,
      };
    case 'coding-agent': {
      if (!flags.federatedRead || flags.federatedRead.length === 0) {
        throw new Error(
          'coding-agent requires --federated-read: a coding agent that reads nothing but its own scratch workspace is a misconfiguration. Pass the project sources it should read, e.g. --federated-read proj-widget',
        );
      }
      let writeSource = flags.source;
      let workspaceDerived = false;
      if (writeSource === undefined) {
        if (name.length > WORKSPACE_NAME_MAX || !SOURCE_ID_RE.test(`${name}${WORKSPACE_SUFFIX}`)) {
          throw new Error(
            `cannot derive a workspace source from "${name}": "${name}${WORKSPACE_SUFFIX}" must match ${String(SOURCE_ID_RE)} (name ≤ ${WORKSPACE_NAME_MAX} chars, lowercase letters/digits/hyphens). Pass --source <id> or shorten the name.`,
          );
        }
        writeSource = `${name}${WORKSPACE_SUFFIX}`;
        workspaceDerived = true;
      }
      return {
        scopes: explicit(flags.scopes, 'read write'),
        writeSource,
        federatedRead: [writeSource, ...flags.federatedRead.filter(s => s !== writeSource)],
        // starter, not full: `full` exposes brain-wide unscoped code-intel
        // reads to a scoped client. Widen per client via
        // `gbrain auth rescope-client --surface full`.
        surface: explicit(flags.surface, 'starter'),
        workspaceDerived,
      };
    }
    default:
      // No preset → passthrough defaults matching `auth register-client`
      // (no surface write, no snapshot).
      return {
        scopes: explicit(flags.scopes, 'read write'),
        writeSource: explicit(flags.source, 'default'),
        federatedRead: flags.federatedRead ?? [explicit(flags.source, 'default')],
        surface: flags.surface,
        workspaceDerived: false,
      };
  }
}

/**
 * daily-driver snapshot grant: all non-archived sources EXCEPT derived agent
 * workspaces (`*-workspace`). A workspace is another agent's scratch memory
 * by construction — sharing one requires an explicit --federated-read grant,
 * never a default-on snapshot sweep. The write source is re-added by the
 * runner's write-source-always-readable invariant, so an operator who
 * EXPLICITLY targets a workspace still gets it. Exported for the unit suite.
 */
export function snapshotGrantSources(ids: string[]): { granted: string[]; excludedWorkspaces: string[] } {
  const granted: string[] = [];
  const excludedWorkspaces: string[] = [];
  for (const id of ids) {
    (id.endsWith(WORKSPACE_SUFFIX) ? excludedWorkspaces : granted).push(id);
  }
  return { granted, excludedWorkspaces };
}

// ── runner ────────────────────────────────────────────────────────────────

interface RegisterOutput {
  registered: RegisteredClient;
  accessToken?: string;
  tokenExpiresAt?: string;
  presetResolved: {
    preset: string | null;
    scopes: string;
    write_source: string;
    federated_read: string[];
    surface: string | null;
    token_ttl: number | null;
  };
  serveWarning: string | null;
  probeNote: string | null;
  block: string;
  url: string;
}

function fail(json: boolean, reason: RegisterFailReason, message: string, exitCode: 1 | 2, clientId?: string): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, reason, message, ...(clientId ? { client_id: clientId } : {}) }));
  } else {
    console.error(`Error: ${message}`);
    if (clientId) {
      console.error(`The OAuth client was created before the failure. Revoke with: gbrain auth revoke-client "${clientId}"`);
    }
  }
  process.exit(exitCode);
}

export async function runAgentRegister(engine: BrainEngine | null, args: string[]): Promise<void> {
  // Help is answered by runAgent BEFORE this is called; a null engine here
  // means the dispatcher's help path leaked a real invocation — refuse.
  const wantsJson = args.includes('--json');
  if (engine === null) {
    fail(wantsJson, 'internal', 'agent register needs a configured brain (no engine available).', 1);
  }

  // Belt-and-braces: cli.ts refuses pre-connect; re-check here for direct callers.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    fail(wantsJson, 'thin_client', THIN_CLIENT_REGISTER_MESSAGE, 1);
  }

  let flags: AgentRegisterArgs;
  try {
    flags = parseAgentRegisterArgs(args);
  } catch (e: any) {
    fail(wantsJson, 'invalid_argument', e.message, 2);
  }

  // --url | --port resolution (required by every harness block). The config
  // remote_mcp fallback is dead by construction: thin clients are refused.
  const rawUrl = flags.url ?? (flags.port !== undefined ? `http://localhost:${flags.port}/mcp` : undefined);
  if (!rawUrl) {
    fail(flags.json, 'invalid_argument',
      `pass --url <mcp-url> or --port <serve-port> — every harness block embeds the brain URL. Example: --url https://brain.example.com/mcp\n${REGISTER_USAGE}`, 2);
  }
  const urlResult = normalizeMcpUrl(rawUrl);
  if (!urlResult.ok) {
    fail(flags.json, 'invalid_argument', urlResult.error, 2);
  }
  const url = urlResult.url;
  const urlWarning = urlResult.warning ?? null;

  const sql = sqlQueryForEngine(engine);

  try {
    if (flags.reissueClientId !== undefined) {
      const out = await runReissue(sql, engine, flags, url, urlWarning);
      printOutput(flags, out);
      return;
    }

    const preset = resolvePreset(flags);
    const name = flags.name!;

    // Existence + not-archived check for a set of source ids. Engine lane
    // for the ANY() — SqlQuery forbids arrays. Shared by the explicit and
    // snapshot branches so the write source is validated the same way on both.
    const validateSourceIds = async (ids: string[]): Promise<void> => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      const rows = await engine.executeRaw<{ id: string; archived: boolean | null }>(
        `SELECT id, archived FROM sources WHERE id = ANY($1::text[])`,
        [unique],
      );
      const found = new Map(rows.map(r => [r.id, r]));
      for (const id of unique) {
        const row = found.get(id);
        if (!row) {
          fail(flags.json, 'unknown_source',
            `source "${id}" does not exist — create it first (gbrain sources add ${id}) or check the spelling with \`gbrain sources list\`. Only the derived <name>-workspace is auto-created.`, 1);
        }
        if (row.archived) {
          fail(flags.json, 'archived_source',
            `source "${id}" is archived — unarchive it or drop it from the grant.`, 1);
        }
      }
    };

    // Resolve the snapshot + validate every explicit source id (existence +
    // not archived).
    let federated: string[];
    if (preset.federatedRead === 'snapshot') {
      const all = await loadAllSources(engine, { includeArchived: false });
      const snap = snapshotGrantSources(all.map(s => s.id));
      federated = snap.granted;
      if (snap.excludedWorkspaces.length > 0) {
        console.error(
          `Note: snapshot grant excludes ${snap.excludedWorkspaces.length} agent workspace source(s) ` +
          `(${snap.excludedWorkspaces.join(', ')}) — agent scratch is not shared by default; ` +
          `grant one explicitly with --federated-read.`,
        );
      }
      // The snapshot proves existence + non-archived for its members only.
      // A write source OUTSIDE it (and any explicitly passed --source, even
      // when it happens to be inside) gets the same check as the explicit
      // branch — otherwise a typo'd or archived --source would be granted
      // and then die at the FK (or worse, silently write nowhere readable).
      if (!federated.includes(preset.writeSource) || flags.source !== undefined) {
        await validateSourceIds([preset.writeSource]);
      }
    } else {
      federated = preset.federatedRead;
      const toCheck = federated.filter(id => !(preset.workspaceDerived && id === preset.writeSource));
      if (!preset.workspaceDerived) toCheck.push(preset.writeSource);
      await validateSourceIds(toCheck);
    }
    // INVARIANT (every branch): the write source is always in the read grant.
    // A client that can't read its own write source is a remember→recall
    // black hole.
    if (!federated.includes(preset.writeSource)) federated.push(preset.writeSource);

    // Column pre-flight: OUTSIDE the tx (25P02 — nothing inside may degrade).
    const columns = await preflightOauthClientColumns(sql);
    // Pre-v61 brains lack the scoped-client columns entirely; refuse BEFORE
    // the tx — registerClientManual's own 42703 retry ladder would die on
    // 25P02 inside our transaction.
    if (!columns.has('source_id') || !columns.has('federated_read')) {
      fail(flags.json, 'brain_too_old',
        'this brain predates scoped OAuth clients (source_id/federated_read columns) — run `gbrain apply-migrations --yes` first.', 1);
    }
    const ttl = flags.tokenTtlSeconds ?? REGISTER_DEFAULT_TOKEN_TTL_SECONDS;
    const preflightNotes: string[] = [];
    if (!columns.has('token_ttl')) {
      preflightNotes.push('this brain predates the token_ttl column; run `gbrain apply-migrations --yes` — the server default (1 hour) applies until then.');
    }
    if (preset.surface !== undefined && !columns.has('surface')) {
      preflightNotes.push('this brain predates the surface column; run `gbrain apply-migrations --yes` — no per-client surface tier was set.');
    }
    for (const note of preflightNotes) console.error(`Note: ${note}`);

    const registerArgs: RegisterClientArgs = {
      grantTypes: ['client_credentials'],
      scopes: preset.scopes,
      sourceId: preset.writeSource,
      federatedRead: federated,
      redirectUris: [],
      tokenEndpointAuthMethod: undefined,
      boundTools: undefined,
      boundSourceId: undefined,
      boundBrainId: undefined,
      boundSlugPrefixes: undefined,
      boundMaxConcurrent: undefined,
      budgetUsdPerDay: undefined,
      tokenTtlSeconds: undefined,
    };

    let registered!: RegisteredClient;
    let createdWorkspace = false;
    await engine.transaction(async (tx) => {
      const txSql = sqlQueryForEngine(tx);
      // Name-scoped advisory lock: no unique index exists on client_name, so
      // two concurrent registers of the same name would both pass the
      // pre-check. xact-scoped — released at COMMIT/ROLLBACK.
      await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [registerClientNameLockKey(name)]);

      const dupRows = columns.has('deleted_at')
        ? await txSql`SELECT client_id FROM oauth_clients WHERE client_name = ${name} AND deleted_at IS NULL`
        : await txSql`SELECT client_id FROM oauth_clients WHERE client_name = ${name}`;
      if (dupRows.length > 0) {
        throw new RegisterError('duplicate_name',
          `an OAuth client named "${name}" already exists (${String(dupRows[0].client_id)}). Revoke it first (gbrain auth revoke-client "${String(dupRows[0].client_id)}") or rotate its secret with --reissue.`);
      }

      if (preset.workspaceDerived) {
        createdWorkspace = await ensureWorkspaceSource(tx, txSql, preset.writeSource);
      }

      registered = await registerScopedClient(txSql, name, registerArgs, {
        tokenTtlSeconds: ttl,
        surface: preset.surface,
        columns,
      });
    });
    registered.created.source = createdWorkspace;

    // POST-COMMIT: a client row now exists — from here, EVERY failure must
    // carry the clientId so fail() prints the revoke guidance (never a false
    // "nothing was created"). RegisterErrors keep their reason; anything else
    // maps to mint_failed with the clientId attached.
    try {
      // Post-commit, fail-open audit (its designed position — never in the tx).
      if (registered.surface !== undefined) {
        await writeSurfaceChangeAudit(engine, {
          actor: 'operator',
          client_id: registered.clientId,
          old: registered.surfaceOld ?? null,
          new: registered.surface,
          via: 'register_cli',
        });
      }

      const out = await mintAndProbe(engine, flags, registered, name, url, urlWarning, {
        preset: flags.preset ?? null,
        scopes: preset.scopes,
        write_source: preset.writeSource,
        federated_read: federated,
        surface: registered.surface ?? null,
        token_ttl: registered.tokenTtl ?? null,
      });
      printOutput(flags, out);
    } catch (e: any) {
      if (e instanceof RegisterError) {
        throw new RegisterError(e.reason, e.message, e.clientId ?? registered.clientId);
      }
      throw new RegisterError('mint_failed', e?.message ?? String(e), registered.clientId);
    }
  } catch (e: any) {
    if (e instanceof RegisterError) {
      fail(flags.json, e.reason, e.message, 1, e.clientId);
    }
    fail(flags.json, 'mint_failed', e?.message ?? String(e), 1);
  }
}

/** Create the derived workspace source if missing; reuse only when clean.
 * Returns true when this call created it. Never catches source_id_taken as
 * control flow — existence is decided by SELECT first. "Clean" means: not
 * archived, no local path, zero pages AND zero facts AND zero files (facts
 * are the primary agent write lane, and files can exist page-less — a
 * pages-only check would silently reuse a source that already holds another
 * agent's memory). raw_data and links are FK-subsumed: both are page-scoped
 * (NOT NULL page FKs, ON DELETE CASCADE, no source_id column), so they
 * cannot be non-zero when the page count is zero; there is no `entities`
 * table (entity pages count as pages, fact entities count as facts).
 * Exported for the unit suite. */
export async function ensureWorkspaceSource(
  tx: BrainEngine,
  txSql: SqlQuery,
  id: string,
): Promise<boolean> {
  const existing = await txSql`SELECT id, local_path, archived FROM sources WHERE id = ${id}`;
  if (existing.length > 0) {
    if (existing[0].archived === true) {
      throw new RegisterError('archived_source',
        `workspace source "${id}" exists but is archived — unarchive it (gbrain sources restore ${id}) or pick another name.`);
    }
    const localPath = existing[0].local_path;
    const pages = await txSql`SELECT count(*) AS n FROM pages WHERE source_id = ${id}`;
    const nPages = Number(pages[0]?.n ?? 0);
    const facts = await txSql`SELECT count(*) AS n FROM facts WHERE source_id = ${id}`;
    const nFacts = Number(facts[0]?.n ?? 0);
    // files: tolerant of a brain without the table — probed via
    // information_schema (NEVER try/catch: this runs inside the register tx,
    // where an aborted statement is a 25P02, not a degrade).
    let nFiles = 0;
    const filesTable = await txSql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'files'`;
    if (filesTable.length > 0) {
      const files = await txSql`SELECT count(*) AS n FROM files WHERE source_id = ${id}`;
      nFiles = Number(files[0]?.n ?? 0);
    }
    if (localPath != null || nPages > 0 || nFacts > 0 || nFiles > 0) {
      const why = localPath != null
        ? 'is backed by a local path'
        : nPages > 0 ? `holds ${nPages} pages`
          : nFacts > 0 ? `holds ${nFacts} facts` : `holds ${nFiles} files`;
      throw new RegisterError('dirty_source',
        `source "${id}" already exists and ${why} — pass --source ${id} to reuse it deliberately, or pick another agent name.`);
    }
    console.error(`Note: reusing existing empty workspace source "${id}".`);
    return false;
  }
  await addSource(tx, { id });
  return true;
}

/** Shared tail: exchange client credentials, probe the serve, build the block.
 * `blockName` is the MCP server name embedded in the harness block: the agent
 * name on the register lane, the stored client_name (when valid) on reissue. */
async function mintAndProbe(
  engine: BrainEngine,
  flags: AgentRegisterArgs,
  registered: RegisteredClient,
  blockName: string,
  url: string,
  urlWarning: string | null,
  presetResolved: RegisterOutput['presetResolved'],
): Promise<RegisterOutput> {
  const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
  // The tx-scoped sql is dead after COMMIT — the exchange runs on the OUTER engine.
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });

  let accessToken: string | undefined;
  let tokenExpiresAt: string | undefined;
  if (registered.clientSecret) {
    try {
      const tokens = await provider.exchangeClientCredentials(registered.clientId, registered.clientSecret);
      accessToken = tokens.access_token;
      if (typeof tokens.expires_in === 'number') {
        tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      }
    } catch (e: any) {
      throw new RegisterError('mint_failed',
        `client registered but the token exchange failed: ${e?.message ?? String(e)}`, registered.clientId);
    }
  }

  // Serve probe. An UNREACHABLE serve stays a note (it proves nothing). A
  // reachable serve that PROVES version < SCOPES_MIN_SERVE_VERSION fails the
  // registration lane — that serve verifies the freshly-minted scoped token
  // as FULL ACCESS — unless the operator passed --allow-old-serve. The
  // reissue lane keeps the warning: by this point the secret is already
  // ROTATED, and failing would discard the only copy of the new credential.
  let probeNote: string | null = null;
  const health = await probeServeHealth(url, fetch);
  if (!health.ok) {
    probeNote = `could not reach ${url.replace(/\/mcp$/, '')}/health — skipping the scoped-token version check (${health.detail ?? 'unreachable'}).`;
  } else if (health.version && isServeOlderThanScopes(health.version)) {
    if (flags.reissueClientId === undefined && !flags.allowOldServe) {
      throw new RegisterError('serve_too_old',
        `serve at ${url} reports v${health.version} — older than ${SCOPES_MIN_SERVE_VERSION}, so it verifies this scoped token as FULL ACCESS (the scope grant is not enforced). Upgrade the serve, or re-run with --allow-old-serve to accept the risk.`,
        registered.clientId);
    }
    probeNote = `serve at ${url} reports v${health.version} — OLDER than ${SCOPES_MIN_SERVE_VERSION}: it verifies this scoped token as FULL ACCESS. Upgrade the serve.`;
  } else {
    probeNote = `serve health: OK${health.version ? ` (v${health.version})` : ''}.`;
  }

  const block = buildHarnessBlock(flags.harness!, {
    name: blockName,
    url,
    token: accessToken ?? null,
    clientId: registered.clientId,
    clientSecret: registered.clientSecret ?? null,
    showToken: flags.showToken,
    expiresAt: tokenExpiresAt ?? null,
    isReissue: flags.reissueClientId !== undefined,
  });

  return {
    registered,
    accessToken,
    tokenExpiresAt,
    presetResolved,
    serveWarning: urlWarning,
    probeNote,
    block,
    url,
  };
}

/** --reissue: rotate the client secret and reprint the block. Outstanding
 * access tokens remain valid until they expire — rotation is not revocation. */
async function runReissue(
  sql: SqlQuery,
  engine: BrainEngine,
  flags: AgentRegisterArgs,
  url: string,
  urlWarning: string | null,
): Promise<RegisterOutput> {
  const clientId = flags.reissueClientId!;
  const columns = await preflightOauthClientColumns(sql);
  // Projection derived from the pre-flight column set: pre-migration brains
  // lack source_id/federated_read/token_ttl/deleted_at — drop the absent ones
  // (the ?? defaults below tolerate missing keys). Column names come from a
  // fixed allowlist, never caller input.
  const projection = [
    'client_id', 'client_name', 'grant_types', 'client_secret_hash',
    ...['source_id', 'federated_read', 'token_ttl', 'deleted_at'].filter(c => columns.has(c)),
  ];
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT ${projection.join(', ')} FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  if (rows.length === 0) {
    throw new RegisterError('reissue_invalid_target', `no OAuth client with id "${clientId}" — list clients with \`gbrain auth clients\`.`);
  }
  const row = rows[0] as Record<string, unknown>;
  if (row.deleted_at != null) {
    throw new RegisterError('reissue_invalid_target', `client "${clientId}" is deleted — register a new one.`);
  }
  if (row.client_secret_hash == null) {
    throw new RegisterError('reissue_invalid_target', `client "${clientId}" is a public (PKCE) client — it has no secret to rotate.`);
  }
  const grants = Array.isArray(row.grant_types) ? (row.grant_types as string[]) : String(row.grant_types ?? '').split(',');
  if (!grants.includes('client_credentials')) {
    throw new RegisterError('reissue_invalid_target', `client "${clientId}" has no client_credentials grant — nothing to reissue.`);
  }

  const newSecret = await rotateClientSecret(engine, clientId, String(row.client_name));

  const registered: RegisteredClient = {
    clientId,
    clientSecret: newSecret,
    grantTypes: grants,
    scopes: '(unchanged)',
    authMethod: 'client_secret_post',
    redirectUris: [],
    sourceId: String(row.source_id ?? 'default'),
    federatedRead: Array.isArray(row.federated_read) ? (row.federated_read as string[]) : [String(row.source_id ?? 'default')],
    ...(typeof row.token_ttl === 'number' ? { tokenTtl: row.token_ttl } : {}),
    created: { source: false },
  };

  // MCP server name: the stored client_name when it is a valid server name
  // (it was validated at registration, but DCR/legacy rows may carry
  // arbitrary text) — fall back to the client id otherwise.
  const clientName = String(row.client_name ?? '');
  const blockName = isValidName(clientName) ? clientName : clientId;
  const out = await mintAndProbe(engine, flags, registered, blockName, url, urlWarning, {
    preset: null,
    scopes: registered.scopes,
    write_source: registered.sourceId,
    federated_read: registered.federatedRead,
    surface: null,
    token_ttl: registered.tokenTtl ?? null,
  });
  out.probeNote = `${out.probeNote ?? ''}${out.probeNote ? ' ' : ''}Secret ROTATED: the old secret no longer mints tokens; outstanding access tokens stay valid until expiry — revoke the client to kill them now.`;
  return out;
}

/** Rotate a confidential client's secret under the same name-scoped advisory
 * lock registration uses. Rotation is NOT revocation: outstanding access
 * tokens stay valid until they expire. Exported for the unit suite. */
export async function rotateClientSecret(engine: BrainEngine, clientId: string, clientName: string): Promise<string> {
  let newSecret!: string;
  await engine.transaction(async (tx) => {
    const txSql = sqlQueryForEngine(tx);
    await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [registerClientNameLockKey(clientName)]);
    newSecret = generateToken('gbrain_cs_');
    const updated = await txSql`
      UPDATE oauth_clients SET client_secret_hash = ${hashToken(newSecret)}
      WHERE client_id = ${clientId}
      RETURNING client_id
    `;
    if (updated.length === 0) throw new RegisterError('reissue_invalid_target', `client "${clientId}" vanished mid-rotation.`);
  });
  return newSecret;
}

// ── rendering ─────────────────────────────────────────────────────────────

function buildHarnessBlock(
  harness: RegisterHarness,
  p: { name: string; url: string; token: string | null; clientId: string; clientSecret: string | null; showToken: boolean; expiresAt: string | null; isReissue: boolean },
): string {
  const shownToken = p.token ? (p.showToken ? p.token : REDACTED) : '<mint-a-token>';
  const shownSecret = p.clientSecret ? (p.showToken ? p.clientSecret : REDACTED) : REDACTED;
  // Lane-honest recovery: re-running `agent register <name>` fails on
  // duplicate_name, so the register lane names the REAL recovery (--reissue);
  // the reissue lane's re-run genuinely works, so it keeps the simple hint.
  const hintText = p.isReissue
    ? '(credentials redacted — re-run with --show-token for a paste-ready block)'
    : `(credentials redacted — reissue a paste-ready block with: gbrain agent register --reissue ${p.clientId} --harness ${harness} --url ${p.url} --show-token)`;
  const redactionHint = p.showToken ? [] : [hintText];
  switch (harness) {
    case 'claude-code': {
      const cmd = cmdString('claude', buildClaudeMcpAddArgv({ name: p.name, url: p.url, headerToken: shownToken }));
      return ['# Paste into Claude Code:', '', `  ${cmd}`, '', ...redactionHint].join('\n');
    }
    case 'codex': {
      const cmd = cmdString('codex', buildCodexMcpAddArgv({ name: p.name, url: p.url, envVar: GBRAIN_REMOTE_TOKEN_ENV }));
      const toml = renderCodexHttpServerBlock({ name: p.name, url: p.url, bearerToken: shownToken });
      return [
        '# Paste into Codex:',
        '',
        `  export ${GBRAIN_REMOTE_TOKEN_ENV}=${shellQuote(shownToken)}`,
        `  ${cmd}`,
        '',
        `# Or add to ~/.codex/config.toml directly (then: chmod 600 ~/.codex/config.toml):`,
        toml,
        '',
        ...redactionHint,
      ].join('\n');
    }
    case 'opencode': {
      const cmd = cmdString('opencode', buildOpencodeMcpAddArgv({ name: p.name, url: p.url, envVar: GBRAIN_REMOTE_TOKEN_ENV }));
      return [
        '# Paste into opencode:',
        '',
        `  export ${GBRAIN_REMOTE_TOKEN_ENV}=${shellQuote(shownToken)}`,
        `  ${cmd}`,
        '',
        ...redactionHint,
      ].join('\n');
    }
    case 'openclaw':
      return openclawThinClientBlock({
        issuerUrl: issuerFromMcpUrl(p.url),
        mcpUrl: p.url,
        clientId: p.clientId,
        clientSecret: shownSecret,
      }) + (p.showToken ? '' : `\n\n${hintText}`);
  }
}

function printOutput(flags: AgentRegisterArgs, out: RegisterOutput): void {
  const r = out.registered;
  const expiry = out.tokenExpiresAt ?? null;
  const floorLine = `token scoping requires serve ≥ ${SCOPES_MIN_SERVE_VERSION}; an older serve verifies this token as full access.`;

  if (flags.json) {
    // ONE JSON document on stdout; every note goes to stderr.
    if (out.serveWarning) console.error(out.serveWarning);
    if (out.probeNote) console.error(out.probeNote);
    console.error(floorLine);
    console.log(JSON.stringify({
      ok: true,
      schema_version: 1,
      client_id: r.clientId,
      client_secret: r.clientSecret ? (flags.showToken ? r.clientSecret : REDACTED) : null,
      secret_redacted: !!r.clientSecret && !flags.showToken,
      access_token: out.accessToken ? (flags.showToken ? out.accessToken : REDACTED) : null,
      token_redacted: !!out.accessToken && !flags.showToken,
      token_expires_at: expiry,
      mcp_url: out.url,
      harness: flags.harness,
      preset_resolved: out.presetResolved,
      created_workspace_source: r.created.source,
      skipped: r.skipped ?? null,
      // probe_note carries the serve health-probe result; serve_warning is
      // the URL http-token warning (null when the URL is clean).
      probe_note: out.probeNote,
      serve_warning: out.serveWarning ?? null,
      block: out.block,
    }));
    return;
  }

  // Lane-honest header: rotation is not registration (JSON shape unchanged —
  // this is the human printer only).
  const header = flags.reissueClientId !== undefined
    ? `Agent client secret ROTATED: "${flags.name ?? r.clientId}"`
    : `Agent client registered: "${flags.name ?? r.clientId}"`;
  console.log(`${header}\n`);
  console.log(`  Client ID:           ${r.clientId}`);
  if (r.clientSecret) {
    console.log(`  Client Secret:       ${flags.showToken ? r.clientSecret : REDACTED}`);
  }
  console.log(`  Scopes:              ${out.presetResolved.scopes}`);
  console.log(`  Write source:        ${out.presetResolved.write_source}${r.created.source ? '  (created)' : ''}`);
  console.log(`  Federated reads:     ${out.presetResolved.federated_read.join(', ')}`);
  if (out.presetResolved.surface) {
    console.log(`  Surface tier:        ${out.presetResolved.surface} (widen: gbrain auth rescope-client "${r.clientId}" --surface full)`);
  }
  if (out.presetResolved.token_ttl) {
    console.log(`  Token TTL:           ${out.presetResolved.token_ttl}s`);
  }
  if (expiry) {
    console.log(`  Token expires:       ${expiry} — reissue with: gbrain agent register --reissue ${r.clientId} --harness ${flags.harness} --url ${out.url}`);
  }
  console.log('');
  console.log(out.block);
  console.log('');
  if (out.serveWarning) console.log(out.serveWarning);
  if (out.probeNote) console.log(out.probeNote);
  console.log(floorLine);
  console.log('');
  console.log(OAUTH_SECRET_NOTE);
  console.log(`Revoke with: gbrain auth revoke-client "${r.clientId}"`);
}

// ── help ──────────────────────────────────────────────────────────────────

export function printRegisterHelp(): void {
  console.log(`gbrain agent register — mint a scoped OAuth client + token and print the harness wiring

${REGISTER_USAGE}

PRESETS
  daily-driver   read-broad, write to one source. Federated reads default to a
                 SNAPSHOT of all current non-archived sources EXCLUDING other
                 agents' *-workspace sources (agent scratch — share one via an
                 explicit --federated-read). New sources need a re-grant via
                 \`gbrain auth rescope-client\`. Surface: starter.
  coding-agent   write-isolated: writes land in <name>${WORKSPACE_SUFFIX} (auto-created,
                 DB-only). Requires --federated-read (the project sources it may
                 read). Surface: starter.

NOTES
  Runs on the BRAIN HOST (a thin client is refused). Every block embeds the
  brain URL: pass --url or --port. The minted token defaults to a 30-day TTL
  (the server default is 1 hour); the printed expiry comes from the exchange.
  A reachable serve that reports a version older than ${SCOPES_MIN_SERVE_VERSION}
  FAILS the registration (it would treat the scoped token as full access);
  pass --allow-old-serve to accept that risk. An unreachable serve is only a
  note. --reissue <client-id> rotates the client secret and reprints the
  block; outstanding tokens stay valid until expiry.`);
}
