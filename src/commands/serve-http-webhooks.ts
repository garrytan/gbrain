/**
 * Network ingestion for `gbrain serve --http`: the OAuth-authenticated
 * POST /ingest webhook source (v0.38) and the HMAC-verified
 * POST /webhooks/github push / item-event sync trigger (v0.40, v0.46).
 */
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHmac } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { safeHexEqual } from '../core/timing-safe.ts';
import { isValidRepoName } from '../core/github-source.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { AuthInfo } from '../core/operations.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { OperationError } from '../core/ops/contract.ts';
import { ERROR_CATALOGUE } from '../core/error-catalogue.ts';
import {
  computeContentHash,
  validateIngestionEvent,
  type IngestionContentType,
  type IngestionEvent,
} from '../core/ingestion/types.ts';
import type { ServeHttpContext } from './serve-http.ts';

/**
 * v0.46: normalize the per-event GitHub webhook payload shape into
 * {repo, number, kind}. Events differ: issues/issue_comment/label/
 * assignee/milestone carry a top-level `issue` (PRs appear there too,
 * flagged by `issue.pull_request`), pull_request/review events carry
 * top-level `pull_request`, and check events nest the linked PRs under
 * check_run/check_suite/workflow_run. Returns null when the payload
 * carries no item reference (ping, branch, non-PR checks).
 */
export function extractGitHubItemRef(parsed: Record<string, unknown>): { repo: string; number: number; kind: 'issue' | 'pr' } | null {
  const repoObj = parsed.repository as { full_name?: string } | undefined;
  const repo = repoObj?.full_name ?? '';
  const issueObj = parsed.issue as { number?: number; pull_request?: unknown } | undefined;
  const prObj = parsed.pull_request as { number?: number } | undefined;
  const checkRun = parsed.check_run as { pull_requests?: Array<{ number?: number }> } | undefined;
  const checkSuite = parsed.check_suite as { pull_requests?: Array<{ number?: number }> } | undefined;
  const workflowRun = parsed.workflow_run as { pull_requests?: Array<{ number?: number }> } | undefined;
  const nestedPrNumber =
    checkRun?.pull_requests?.[0]?.number ??
    checkSuite?.pull_requests?.[0]?.number ??
    workflowRun?.pull_requests?.[0]?.number;
  const number = prObj?.number ?? issueObj?.number ?? nestedPrNumber;
  if (typeof number !== 'number' || !isValidRepoName(repo)) return null;
  const kind = prObj !== undefined || issueObj?.pull_request !== undefined || nestedPrNumber !== undefined ? 'pr' : 'issue';
  return { repo, number, kind };
}

/**
 * True when a github-kind source covers `fullName`: explicit gh_repos list
 * for scope=repos, the last-discovered state file for scope=auto (accept
 * when no state exists yet — the sync engine re-checks scope). Repo names
 * are case-insensitive on GitHub, so matching folds case on both sides
 * (config and legacy state files may carry canonical-case entries).
 */
export function githubKindCoversRepo(
  cfg: Record<string, unknown>,
  localPath: string | null,
  fullName: string,
): boolean {
  const repo = fullName.toLowerCase();
  if (cfg.gh_scope === 'repos') {
    const repos = typeof cfg.gh_repos === 'string' ? cfg.gh_repos.split(',').map((s) => s.trim().toLowerCase()) : [];
    return repos.includes(repo);
  }
  if (localPath) {
    try {
      const state = JSON.parse(readFileSync(join(localPath, '.github-source.json'), 'utf-8')) as {
        repos?: unknown[];
      };
      if (Array.isArray(state.repos)) {
        return state.repos.some((r) => typeof r === 'string' && r.toLowerCase() === repo);
      }
    } catch {
      /* no state yet */
    }
  }
  return true;
}

/**
 * Partition signature-verified webhook sources for an item event. Only a
 * github-kind source can service a github_item refresh — the sync core
 * rejects github_item on any other kind, so enqueueing for a legacy
 * github_repo push source would only mint a dead job. Legacy matches are
 * reported so the handler can ACK-and-ignore them instead.
 */
export function selectGitHubItemSources<Row extends { local_path: string | null; config: unknown }>(
  rows: Row[],
  repo: string,
  verify: (cfg: Record<string, unknown>) => boolean,
): { verified: Row[]; legacyMatched: boolean } {
  const verified: Row[] = [];
  let legacyMatched = false;
  for (const row of rows) {
    const cfg = (typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {})) as Record<string, unknown>;
    if (cfg.kind === 'github' && githubKindCoversRepo(cfg, row.local_path, repo) && verify(cfg)) {
      verified.push(row);
      continue;
    }
    if (cfg.github_repo === repo && verify(cfg)) legacyMatched = true;
  }
  return { verified, legacyMatched };
}

/** Per-server limiters for the two ingestion routes (carried on ServeHttpContext). */
export function createWebhookLimiters() {
  const ingestRateLimiter = rateLimit({
    windowMs: 10_000, // 10 seconds
    limit: 100, // 100 events per IP per window
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many /ingest events; backoff and retry' },
  });
  const githubWebhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limit_exceeded', message: 'too many GitHub webhook requests' },
  });
  return { ingestRateLimiter, githubWebhookLimiter };
}

/**
 * v0.46: issue/PR event handling for github-kind sources. The payload
 * names a single item (repo + number); we verify the per-source HMAC and
 * submit a targeted `sync` job with github_item so exactly that item is
 * refreshed. Out-of-scope repos are rejected at queue time by the sync
 * engine's own scope check.
 */
async function handleGitHubItemEvent(
  engine: BrainEngine,
  parsed: Record<string, unknown>,
  sigHeader: string,
  payload: Buffer,
  res: Response,
  eventName: string,
): Promise<void> {
  const ref = extractGitHubItemRef(parsed);
  if (ref === null) {
    // Not an item-bearing payload (e.g. check events without a linked PR,
    // ping, branch protection). Acknowledge so GitHub does not retry.
    res.status(202).json({ status: 'ignored', reason: 'no_item_ref' });
    return;
  }

  // Collect ALL candidate sources: exact github_repo matches (legacy
  // webhook config) and github-kind sources with a webhook secret, then
  // verify HMAC per candidate. Only github-kind sources may enqueue a
  // github_item refresh; two verifying github-kind sources mean ambiguous
  // configuration and must not pick silently.
  let source: { id: string; local_path: string | null; config: unknown } | null = null;
  try {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null; config: unknown }>(
      `SELECT id, local_path, config FROM sources
         WHERE archived = false
           AND ((config->>'github_repo' = $1)
             OR (config->>'kind' = 'github' AND config->>'webhook_secret' IS NOT NULL))`,
      [ref.repo],
    );
    const { verified, legacyMatched } = selectGitHubItemSources(rows, ref.repo, (cfg) =>
      verifyWebhookSig(cfg, sigHeader, payload),
    );
    if (verified.length > 1) {
      res.status(500).json({
        error: 'ambiguous_webhook',
        message: `multiple sources verified the signature for ${ref.repo}; configure one webhook secret per source`,
        sources: verified.map((v) => v.id),
      });
      return;
    }
    if (verified.length === 0 && legacyMatched) {
      // A legacy push-webhook source verified the signature but cannot
      // service item events — ACK so GitHub doesn't retry, exactly like
      // the pre-item-flow non-push behavior.
      res.status(202).json({ status: 'ignored', reason: `event=${eventName}` });
      return;
    }
    source = verified[0] ?? null;
  } catch (err) {
    console.error('webhook: github-kind source lookup error:', err);
    res.status(500).json({ error: 'lookup_failed' });
    return;
  }
  if (!source) {
    res.status(404).json({ error: 'unknown_repo', repo: ref.repo });
    return;
  }

  try {
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'sync',
      {
        sourceId: source.id,
        noExtract: false,
        github_item: {
          repo: ref.repo,
          number: ref.number,
          kind: ref.kind,
          ...(eventName === 'issues' && parsed.action === 'deleted' ? { deleted: true } : {}),
        },
        embed_reason: 'webhook',
      },
      {
        priority: -10,
        idempotency_key: `webhook:item:${source.id}:${ref.repo}:${ref.number}:${Math.floor(Date.now() / 30_000)}`,
        maxWaiting: 1,
      },
    );
    res.status(202).json({ job_id: job.id, source_id: source.id, item: ref });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('webhook: item queue submission error:', msg);
    res.status(500).json({ error: 'queue_submission_failed', message: msg });
  }
}

function verifyWebhookSig(cfg: Record<string, unknown>, sigHeader: string, payload: Buffer): boolean {
  const secret = cfg.webhook_secret;
  if (typeof secret !== 'string' || secret === '') return false;
  // Strict hex shape first: a malformed 64-char signature would make
  // safeHexEqual throw (500 instead of 401).
  if (!/^sha256=[0-9a-f]{64}$/.test(sigHeader)) return false;
  const computedHex = createHmac('sha256', secret).update(payload).digest('hex');
  return safeHexEqual(sigHeader.slice('sha256='.length), computedHex);
}

/** POST /ingest (OAuth write scope) and POST /webhooks/github (per-source HMAC), in registration order. */
export function mountWebhooks(app: Express, ctx: ServeHttpContext): void {
  mountIngest(app, ctx);
  mountGitHubWebhook(app, ctx);
}

function mountIngest(app: Express, ctx: ServeHttpContext): void {
  const { engine, resourceVerifier, resourceMetadataUrl, ingestRateLimiter } = ctx;
  // ---------------------------------------------------------------------------
  // v0.38 ingestion substrate — POST /ingest (webhook source)
  //
  // The webhook ingestion source lives INSIDE serve --http (NOT in the
  // ingestion daemon) per the /plan-eng-review E1 decision. This avoids
  // cross-process IPC: the daemon supervises only daemon-side sources
  // (file-watcher, inbox-folder, cron-scheduler) while serve --http hosts
  // the network surface and submits Minion jobs directly.
  //
  // Auth: existing OAuth `write` scope. Rate limit: 100 events / 10s per
  // IP (reuses the IP-keyed pattern from ccRateLimiter; a future tweak
  // could key on authInfo.clientId for fairer per-agent fairness).
  // Payload cap: 1 MB default. Content-type allowlist: markdown, plain,
  // HTML, JSON. Binary content is REJECTED with HTTP 415 in v1 — the
  // binary-upload flow ships as a separate route in a later wave when
  // content-type processors land.
  //
  // Events always carry untrusted_payload: true because the input came
  // over the network from an OAuth-authenticated but otherwise untrusted
  // source (Zapier / IFTTT / Apple Shortcuts). The downstream
  // ingest_capture handler logs the flag; a future v2 wave wires it
  // through the put_page op to skip auto-link.
  // ---------------------------------------------------------------------------

  // Maximum payload bytes for POST /ingest. Configurable via env. Default 1 MB.
  const ingestMaxBytes = (() => {
    const fromEnv = process.env.GBRAIN_INGEST_MAX_BYTES;
    if (!fromEnv) return 1_048_576;
    const n = parseInt(fromEnv, 10);
    return Number.isFinite(n) && n > 0 ? n : 1_048_576;
  })();

  // Content-type allowlist: text-shaped types only in v1. The handler
  // routes binary content_types with HTTP 415; a future wave + skillpack
  // processors will accept image/audio/video/pdf via a separate flow.
  const INGEST_ALLOWED_CONTENT_TYPES: ReadonlySet<IngestionContentType> = new Set([
    'text/markdown',
    'text/plain',
    'text/html',
    'application/json',
  ]);

  // Single MinionQueue instance shared across POST /ingest invocations
  // (the queue is stateless beyond the engine handle; reusing avoids
  // per-request construction).
  const ingestQueue = new MinionQueue(engine);

  app.post(
    '/ingest',
    ingestRateLimiter,
    requireBearerAuth({ verifier: resourceVerifier, requiredScopes: ['write'], resourceMetadataUrl }),
    express.raw({ type: '*/*', limit: ingestMaxBytes }),
    async (req: Request, res: Response) => handleIngest(ctx, ingestQueue, INGEST_ALLOWED_CONTENT_TYPES, req, res),
  );
}

async function handleIngest(
  ctx: ServeHttpContext,
  ingestQueue: MinionQueue,
  INGEST_ALLOWED_CONTENT_TYPES: ReadonlySet<IngestionContentType>,
  req: Request,
  res: Response,
): Promise<void> {
  const { engine, broadcastEvent } = ctx;
  const startTime = Date.now();
  const authInfo = (req as Request & { auth?: AuthInfo }).auth as AuthInfo;
  const agentName = authInfo.clientName ?? authInfo.clientId;

  // v0.39.3.0 BUG-2: outer try/catch ensures any unexpected throw
  // returns a JSON envelope instead of leaking express's default HTML
  // error page. Mirrors the MCP handler's F14 pattern (serve-http.ts
  // F14 envelope around transport.handleRequest). The `!res.headersSent`
  // guard (codex F#16) prevents a second-response attempt if the throw
  // happens after the inner queue.add try/catch already responded.
  try {

  // The webhook queue bypasses MCP dispatch and does not carry an original
  // operation grant through execution. A snapshot-bound client must use the
  // shared MCP write path until ingestion has that same policy contract.
  if (authInfo.allowedOperations != null || authInfo.grantProjectionDegraded) {
    res.status(403).json({
      error: 'permission_denied',
      message: 'POST /ingest is unavailable to clients with operation snapshots. ' +
        'Use an approved MCP capture, put_page, or remember operation so the current grant is enforced.',
    });
    return;
  }

  // v0.39.3.0 BUG-2: explicit null/undefined guard BEFORE body coercion.
  // When the request has no body at all (no Content-Length header, no
  // body-parser fed us anything), `req.body` is `undefined`. The pre-fix
  // code's `else` branch called `Buffer.from(JSON.stringify(undefined),
  // 'utf8')` — and `JSON.stringify(undefined) === undefined` (the
  // literal, not the string), which makes `Buffer.from(undefined, 'utf8')`
  // throw TypeError. Express's default error handler then served an HTML
  // 500 page. Guard fires first to keep the response shape JSON.
  if (req.body == null) {
    res.status(400).json({
      error: 'empty_body',
      message: 'POST /ingest requires a non-empty body',
    });
    return;
  }

  // Express raw() returns a Buffer. Decode as UTF-8; reject non-UTF-8
  // bytes loudly so callers know their payload was garbled.
  let body: Buffer;
  if (Buffer.isBuffer(req.body)) {
    body = req.body;
  } else if (typeof req.body === 'string') {
    body = Buffer.from(req.body, 'utf8');
  } else {
    // express.json or urlencoded fired earlier in the chain and parsed
    // for us. Re-serialize so we can hash and forward. The null/undefined
    // case is already guarded above so JSON.stringify produces a real
    // string here (objects round-trip, primitives become their JSON form).
    body = Buffer.from(JSON.stringify(req.body), 'utf8');
  }

  if (body.length === 0) {
    res.status(400).json({ error: 'empty_body', message: 'POST /ingest requires a non-empty body' });
    return;
  }

  // Detect content_type. Caller can override via the X-Gbrain-Content-Type
  // header for the JSON case (since the request's Content-Type would say
  // application/json but the user might intend the body to be markdown).
  const declared = (req.header('x-gbrain-content-type') || req.header('content-type') || '').toLowerCase();
  let contentType: IngestionContentType;
  if (declared.startsWith('text/markdown')) {
    contentType = 'text/markdown';
  } else if (declared.startsWith('text/html')) {
    contentType = 'text/html';
  } else if (declared.startsWith('text/plain')) {
    contentType = 'text/plain';
  } else if (declared.startsWith('application/json')) {
    contentType = 'application/json';
  } else if (declared.startsWith('text/')) {
    // Unknown text/* sub-types pass through as text/plain.
    contentType = 'text/plain';
  } else {
    // Binary or unknown — rejected in v1.
    res.status(415).json({
      error: 'unsupported_content_type',
      message: `content_type '${declared}' not supported. Use one of: ${[...INGEST_ALLOWED_CONTENT_TYPES].join(', ')}. ` +
        'Binary content (image/audio/video/pdf) is not yet supported via POST /ingest — install a content-type processor skillpack.',
    });
    return;
  }

  if (!INGEST_ALLOWED_CONTENT_TYPES.has(contentType)) {
    res.status(415).json({
      error: 'unsupported_content_type',
      message: `content_type '${contentType}' is in the taxonomy but not currently accepted by POST /ingest`,
    });
    return;
  }

  const content = body.toString('utf8');
  const contentHash = computeContentHash(content);
  const sourceUri = (req.header('x-gbrain-source-uri') || `mcp-webhook:${authInfo.clientId}:${Date.now()}`).slice(0, 1024);
  const sourceId = `webhook-${authInfo.clientId}`.slice(0, 256);
  const callerSlug = req.header('x-gbrain-slug');

  // Slug-bound clients cannot use /ingest at all. The route hands its
  // payload to the ingest_capture minion handler, which deliberately
  // bypasses the put_page op layer — so no OperationContext exists and
  // enforceClientSlugFence never runs. The caller-supplied
  // X-Gbrain-Source-Id is still never honored, but the write source is now
  // resolved server-side from the client's own OAuth scope, so the write
  // does land inside the client's granted source. The fence gap is
  // therefore the SLUG axis alone: without this 403 a bound client could
  // write any slug within its source, which is exactly the binding it was
  // given. These clients have put_page over MCP, which enforces both the
  // prefix fence and the source scope; webhook integrations use unbound
  // clients.
  const boundPrefixes = authInfo.boundSlugPrefixes;
  if (boundPrefixes || authInfo.fenceProjectionDegraded) {
    res.status(403).json({
      error: 'permission_denied',
      message: authInfo.fenceProjectionDegraded
        ? 'POST /ingest is unavailable: this brain\'s oauth_clients projection is missing ' +
          'bound_slug_prefixes, so client write bindings cannot be evaluated. ' +
          'Run `gbrain apply-migrations --yes` on the brain host.'
        : 'POST /ingest is not available to clients restricted to slug prefixes ' +
          `(bound_slug_prefixes: ${boundPrefixes!.join(', ')}). Write through the MCP put_page op, ` +
          'which enforces the prefix fence and your source scope.',
    });
    return;
  }

  const event: IngestionEvent = {
    source_id: sourceId,
    source_kind: 'webhook',
    source_uri: sourceUri,
    received_at: new Date().toISOString(),
    content_type: contentType,
    content,
    content_hash: contentHash,
    untrusted_payload: true, // ALWAYS true for network input
    metadata: {
      ip: req.ip,
      user_agent: req.header('user-agent') ?? '',
      client_id: authInfo.clientId,
      ...(callerSlug ? { slug: callerSlug } : {}),
    },
  };

  const validationErr = validateIngestionEvent(event);
  if (validationErr) {
    res.status(400).json({
      error: 'invalid_event',
      message: validationErr.message,
      field: validationErr.field,
    });
    return;
  }

  try {
    const writeSourceId = authInfo.sourceId ?? 'default';
    const job = await ingestQueue.add(
      'ingest_capture',
      {
        event,
        ...(callerSlug ? { slug: callerSlug } : {}),
        sourceId: writeSourceId,
      },
      {
        // Idempotency: same content from the same client within the
        // queue's lifetime is a single job. Different content gets
        // different jobs. Daemon-side dedup catches the 24h window;
        // the queue-level idempotency catches simultaneous retries.
        // The effective write source is part of the key: a client rescoped
        // from source X to Y must land a NEW capture in Y rather than being
        // deduped against its old X-bound job.
        idempotency_key: `ingest:webhook:${authInfo.clientId}:${writeSourceId}:${contentHash}`,
        // Cap waiting jobs from a single client so a runaway integration
        // can't fill the queue.
        maxWaiting: 50,
      },
    );

    const latency = Date.now() - startTime;
    try {
      await executeRawJsonb(
        engine,
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [authInfo.clientId, agentName, 'webhook_ingest', latency, 'success'],
        // write_source_id is the security-relevant part of this request:
        // which partition the capture was routed to. Without it the audit
        // trail cannot answer "where did this client's writes land".
        [{ content_type: contentType, content_hash: contentHash, bytes: body.length, job_id: job.id, write_source_id: writeSourceId }],
      );
    } catch { /* best effort */ }
    broadcastEvent({
      agent: agentName,
      operation: 'webhook_ingest',
      scopes: authInfo.scopes.join(','),
      latency_ms: latency,
      status: 'success',
      timestamp: new Date().toISOString(),
    });

    res.status(202).json({
      job_id: job.id,
      content_hash: contentHash,
      // Emitter identity (`webhook-<clientId>`), kept for back-compat.
      source_id: sourceId,
      // The brain source this capture is routed to, resolved server-side
      // from the client's OAuth scope. This is the routing decision the
      // caller actually cares about; `source_id` above is NOT a partition.
      // Enqueue-time intent: the write runs asynchronously after this 202,
      // so a later source_fallback (see the ingest_capture job result) can
      // still redirect it.
      write_source_id: writeSourceId,
      message: 'Accepted. Event queued for ingestion.',
    });
  } catch (err) {
    // A job row left with SQL NULL authority by an upgrade across v0.50 holds
    // this capture's key (or fills its waiting cap): a conflict the operator
    // resolves with the hinted recovery, not a server fault.
    if (err instanceof OperationError && err.docs === ERROR_CATALOGUE.legacy_job_authority.docs) {
      res.status(409).json({ error: err.code, message: err.message, hint: err.suggestion, docs_url: err.docs });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('POST /ingest queue submission error:', msg);
    res.status(500).json({
      error: 'queue_submission_failed',
      message: msg,
    });
  }

  // v0.39.3.0 BUG-2: outer try/catch close — anything that throws BEFORE
  // the inner queue.add try/catch lands here. The headersSent guard
  // (codex F#16) skips the second-response attempt if the inner block
  // already wrote a response and then threw on a downstream line (e.g.
  // a logging side-effect after `res.status(202).json(...)`).
  } catch (outerErr) {
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error('POST /ingest unexpected handler error:', msg);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'internal_error',
        message: msg,
      });
    }
  }
}

function mountGitHubWebhook(app: Express, ctx: ServeHttpContext): void {
  const { engine, githubWebhookLimiter } = ctx;
  // ---------------------------------------------------------------------------
  // POST /webhooks/github — push-triggered sync (v0.40 Federated Sync v2)
  // ---------------------------------------------------------------------------
  // Anonymous endpoint by necessity (GitHub doesn't carry an OAuth token).
  // Auth is via per-source HMAC-SHA256 in the X-Hub-Signature-256 header.
  //
  // D3: 60 req/min/IP rate limit + pre-DB short-circuit on missing
  //     signature, so probe traffic doesn't even touch the source-lookup
  //     query.
  // D5: event=push AND ref-match against sources.config.tracked_branch.
  //     Other event types (ping, pull_request, etc.) return 202 'ignored'
  //     so GitHub doesn't retry.
  // D15.5: HMAC compare uses the shared safeHexEqual helper.
  // D18: submits 'sync' job with extraction + auto_embed_backfill enabled and
  //     priority -10 (above autopilot's 0). This opts normal incremental pushes
  //     into sync's inline extraction while pagesAffected still identifies the
  //     changed pages. The sync core can still defer large (>100) changes.
  // ---------------------------------------------------------------------------
  app.post(
    '/webhooks/github',
    githubWebhookLimiter,
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      // D3 pre-DB short-circuit: missing signature → 401 without any
      // source lookup. Bot probe traffic ends here.
      const sigHeader = req.header('X-Hub-Signature-256');
      if (!sigHeader) {
        res.status(401).json({ error: 'missing_signature', message: 'X-Hub-Signature-256 header is required' });
        return;
      }

      // D5: filter by event header. GitHub fires webhooks for every event
      // type. Anything not in the handled set is acknowledged with 202 +
      // reason so GitHub doesn't retry — but no source lookup or job
      // submission. Push events drive git-source sync (below). Issue/PR
      // events drive github-kind single-item refresh (itemFlow).
      const event = req.header('X-GitHub-Event') ?? '';
      const GH_ITEM_EVENTS = new Set([
        'issues',
        'pull_request',
        'issue_comment',
        'pull_request_review',
        'pull_request_review_comment',
        'label',
        'assignee',
        'milestone',
        'check_run',
        'check_suite',
        'workflow_run',
      ]);
      if (event !== 'push' && !GH_ITEM_EVENTS.has(event)) {
        res.status(202).json({ status: 'ignored', reason: `event=${event || '(missing)'}` });
        return;
      }

      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body), 'utf8');
      if (payload.length === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'malformed_json' });
        return;
      }

      // GitHub-kind item refresh path (v0.46): issues / pull_request /
      // comment / review / label / assignee / milestone / check events
      // refresh exactly the item that changed.
      if (GH_ITEM_EVENTS.has(event)) {
        await handleGitHubItemEvent(engine, parsed, sigHeader, payload, res, event);
        return;
      }

      const pushParsed = parsed as { repository?: { full_name?: string }; ref?: string };
      const fullName = pushParsed.repository?.full_name;
      const ref = pushParsed.ref;
      if (!fullName || !ref) {
        res.status(400).json({ error: 'missing_fields', message: 'repository.full_name and ref are required' });
        return;
      }

      // Source lookup via the v87 partial expression index on
      // config->>'github_repo'. fast even on large brains.
      let source: { id: string; config: Record<string, unknown> | string } | null = null;
      try {
        const rows = await engine.executeRaw<{ id: string; config: Record<string, unknown> | string }>(
          `SELECT id, config FROM sources WHERE config->>'github_repo' = $1 LIMIT 1`,
          [fullName],
        );
        source = rows[0] ?? null;
      } catch (err) {
        console.error('webhook: source lookup error:', err);
        res.status(500).json({ error: 'lookup_failed' });
        return;
      }
      if (!source) {
        res.status(404).json({ error: 'unknown_repo', repo: fullName });
        return;
      }

      const cfg = (typeof source.config === 'string' ? JSON.parse(source.config) : source.config) as {
        webhook_secret?: string;
        tracked_branch?: string;
      };

      // D5: ref must match the configured tracked branch (default 'main').
      const trackedBranch = cfg.tracked_branch ?? 'main';
      const expectedRef = `refs/heads/${trackedBranch}`;
      if (ref !== expectedRef) {
        res.status(202).json({
          status: 'ignored',
          reason: `ref_mismatch`,
          received_ref: ref,
          tracked_branch: trackedBranch,
        });
        return;
      }

      const secret = cfg.webhook_secret;
      if (!secret || typeof secret !== 'string') {
        res.status(401).json({ error: 'webhook_not_configured', message: 'Run: gbrain sources webhook set ' + source.id });
        return;
      }

      // HMAC verify. GitHub sends "sha256=<hex>" — strip the prefix BEFORE
      // safeHexEqual because Buffer.from('sha256=...', 'hex') silently
      // truncates at the first non-hex char (the 's'), leaving both
      // operands as 0-byte buffers and making every signature "match".
      // Strict hex shape first: a malformed 64-char signature would make
      // safeHexEqual throw (500 instead of 401), codex LOW.
      const { createHmac } = await import('node:crypto');
      const computedHex = createHmac('sha256', secret).update(payload).digest('hex');
      const prefix = 'sha256=';
      if (!/^sha256=[0-9a-f]{64}$/.test(sigHeader)) {
        res.status(401).json({ error: 'signature_mismatch', message: 'expected sha256=<64 hex> signature' });
        return;
      }
      if (!safeHexEqual(sigHeader.slice(prefix.length), computedHex)) {
        res.status(401).json({ error: 'signature_mismatch' });
        return;
      }

      // Submit sync job with priority -10 (above autopilot's 0).
      try {
        const queue = new MinionQueue(engine);
        const job = await queue.add(
          'sync',
          {
            sourceId: source.id,
            noExtract: false,
            auto_embed_backfill: true,
            embed_reason: 'webhook',
          },
          {
            priority: -10,
            idempotency_key: `webhook:sync:${source.id}:${Math.floor(Date.now() / 30_000)}`,
            maxWaiting: 1,
          },
        );
        res.status(202).json({ job_id: job.id, source_id: source.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('webhook: queue submission error:', msg);
        res.status(500).json({ error: 'queue_submission_failed', message: msg });
      }
    },
  );
}
