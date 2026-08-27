/**
 * types.ts — the chat-connectors contract surface.
 *
 * A connector fetches a user's OWN conversation history from a hosted AI
 * assistant (ChatGPT, Claude) using the user's own session credential, then
 * spools it in the provider's NATIVE EXPORT shape so the existing
 * `src/core/transcripts/` adapters ingest it with zero pipeline changes. This
 * is the LIVE front-end to the export-file lane the `conversation-archive`
 * skill already documents.
 *
 * Provider modules are leaves on this seam (mirror of the `TranscriptAdapter`
 * seam in `../transcripts/types.ts`): one file per provider, a dated
 * `HostSpecTarget`, and a `spoolFormat` naming which transcript adapter parses
 * its output. Adding a provider is one leaf file.
 *
 * Trust: credentials are session cookies / bearer tokens — password-equivalent.
 * They live file-plane at `~/.gbrain/connectors/<provider>.json` @0600, never in
 * the DB, `sources.config`, the config planes, or any op payload. See
 * `credentials.ts`.
 */

import type { HostSpecTarget } from '../bootstrap/host-specs.ts';
import type { TranscriptFormat } from '../transcripts/types.ts';
import type { ConnectorClient, ConnectorFetch } from './client.ts';

/** Re-export alias so the provider interface can name the fetch seam type. */
export type ConnectorFetchRef = ConnectorFetch;

/** Providers with a live connector in v1. Perplexity stays manual-only (no adapter). */
export type ConnectorProviderName = 'chatgpt' | 'claude';

/**
 * Auth strategy axis. `browser-session` (paste-in cookie) is the PRIMARY lane
 * for both providers — it is the only one proven to reach conversation history.
 * `oauth-pkce` is best-effort/forward-compat, offered only behind `--try-oauth`
 * (ChatGPT tokens are likely codex-scoped). `export-file` is the always-works
 * fallback handled by the conversation-archive skill, not by a live provider.
 */
export type AuthStrategyKind = 'oauth-pkce' | 'browser-session' | 'export-file';

/**
 * A persisted credential. The raw `Cookie` header is stored verbatim (never
 * parsed into individual cookies — they churn); it is the DURABLE credential
 * from which a short-lived `accessToken` is re-minted on 401.
 */
export interface ConnectorCredential {
  provider: ConnectorProviderName;
  strategy: 'oauth-pkce' | 'browser-session';
  /** Bearer token (session accessToken or oauth access_token). Short-lived. */
  accessToken?: string;
  /** OAuth refresh token (oauth-pkce lane only). */
  refreshToken?: string;
  /** Raw `Cookie` header value (browser-session lane; the refresh credential). */
  cookie?: string;
  /** Epoch ms. Absent = unknown; the probe decides validity. */
  expiresAt?: number;
  /** Claude org uuid / ChatGPT account id (multi-account is a v2 field). */
  accountId?: string;
  /** ISO 8601 write time. Compared against auth_error_at by the dispatch gate. */
  savedAt: string;
}

/** Where a resolved credential came from — surfaced by `connectors status`. */
export interface ResolvedCredential {
  cred: ConnectorCredential;
  source: 'env' | 'file';
}

/** A conversation as seen in a provider's LIST endpoint (newest-first). */
export interface ConversationStub {
  id: string;
  title?: string;
  /** ISO 8601 UTC last-update time — the axis the watermark compares against. */
  updatedAt: string;
  createdAt?: string;
}

/** Verdict from a provider `probe()` — did the credential reach history? */
export type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'unauthorized' | 'forbidden_fingerprint' | 'network' | 'drift';
      detail: string;
    };

/**
 * A chat-history provider. Mirrors `TranscriptAdapter` — one leaf module per
 * provider, registered in `registry.ts`.
 */
export interface ChatHistoryProvider {
  name: ConnectorProviderName;
  /** Which transcript adapter parses the spool this provider emits. */
  spoolFormat: TranscriptFormat;
  /** Ordered; first workable wins. First entry is the default lane. */
  strategies: AuthStrategyKind[];
  /** Dated, provisional — these are host formats gbrain does not control. */
  specTarget: HostSpecTarget;
  /** OAuth config, present iff `strategies` includes 'oauth-pkce'. */
  oauth?: OAuthPkceConfig;
  /** Compile-time base origin; overridable in tests via `baseUrlOverride`. */
  baseUrl: string;
  /**
   * Build the auth headers for a request from a resolved credential. Default
   * shape is `{ cookie, authorization: Bearer <accessToken> }` (either/both).
   * The orchestrator wires this into the client's `headers()`.
   */
  authHeaders(cred: ConnectorCredential): Promise<Record<string, string>>;
  /**
   * Re-mint a short-lived accessToken from the durable cookie (chatgpt:
   * `GET /api/auth/session`). Mutates `cred` in place, persists it, returns
   * true on success. Absent when the provider has no re-mint path (claude: the
   * cookie IS the auth, so a 401 is terminal → auth_required).
   */
  refreshAccessToken?(cred: ConnectorCredential, fetchImpl: ConnectorFetchRef): Promise<boolean>;
  /** Cheap liveness check — does this credential reach conversation history? */
  probe(client: ConnectorClient, signal?: AbortSignal): Promise<ProbeResult>;
  /**
   * Yield conversation stubs newest-first. The caller stops paging at its
   * since-bound; the generator honors a per-pass page cap and aborts (never
   * silently truncates) on shape drift.
   */
  listConversations(
    client: ConnectorClient,
    opts?: { signal?: AbortSignal; stopBefore?: string },
  ): AsyncGenerator<ConversationStub>;
  /**
   * Fetch one conversation, normalized to the provider's NATIVE EXPORT object
   * shape — the exact shape the `spoolFormat` adapter already parses. Throws a
   * drift error when the payload lacks its required shape (missing `mapping`
   * for chatgpt, missing `chat_messages` for claude).
   */
  fetchConversation(
    client: ConnectorClient,
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  /** Paste-in credential-capture instructions for the browser-session lane. */
  sessionInstructions(): string;
}

/** OAuth 2.0 Authorization-Code + PKCE config (chatgpt only, forward-compat). */
export interface OAuthPkceConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Loopback redirect port (ChatGPT/Codex convention: 1455). */
  redirectPort: number;
}
