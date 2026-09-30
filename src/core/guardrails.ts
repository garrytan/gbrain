/**
 * Vendor-neutral content guardrail seams.
 *
 * GBrain ingests content (markdown, code) into its retrieval layer and routes
 * queries/tool-inputs through an LLM gateway. A guardrail is an external
 * classifier — a content firewall, a PII scrubber, a prompt-injection detector —
 * that wants to *observe* the content flowing across those boundaries.
 *
 * This module exposes the seams without binding GBrain to any specific vendor.
 * Zero guardrails are registered by default; the OSS distribution ships inert.
 * Operators (or vendor plugins) register a {@link GuardrailProvider} via
 * {@link registerGuardrailProvider}, and the five hook points below await it
 * inline.
 *
 * ## Hard invariants (do not weaken these without an RFC)
 *
 * - **Observe-only.** `runGuardrails` returns `void`. Callers MUST NOT branch
 *   on any provider verdict. A guardrail cannot block, rewrite, drop, retry, or
 *   reorder GBrain behavior through this interface. Enforcement, if ever added,
 *   gets its own explicitly-named seam and its own RFC.
 * - **Fail open.** Missing config, provider throw, timeout, network error, and
 *   malformed responses are all swallowed. A broken guardrail never breaks an
 *   ingest, a query, or a tool call.
 * - **Inline await, no enqueue.** These hooks await the provider before
 *   proceeding so the classifier sees content at the exact pre-persist /
 *   pre-inference moment. Providers that want async fan-out own their own queue.
 * - **No verdict persistence.** GBrain does not write guardrail results to the
 *   DB. Providers own their own audit trail.
 * - **Content boundaries.** Hooks pass the user/ingest-facing payload only:
 *   the markdown/code body, the last user message, the expansion query, the
 *   tool input. They never pass system prompts, full chat history, tool
 *   OUTPUT, LLM output, embeddings, or multimodal/OCR/rerank payloads.
 *
 * @module guardrails
 */
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CWD_DOTENV_REMEDIATION, cwdDotenvAssignsKey } from './env-trust.ts';

/**
 * The boundary at which a guardrail is being consulted. Stable string union so
 * providers can route/score per-surface without parsing free text.
 */
export type GuardrailHook =
  /** Markdown/text body before chunking, embedding, and page persistence. */
  | 'file_storage.markdown'
  /** Code body before code-chunking, embedding, and page persistence. */
  | 'file_storage.code'
  /** Latest user message before LLM inference (chat). */
  | 'ai_gateway.chat'
  /** Search-expansion query before the expansion model call. */
  | 'ai_gateway.expand'
  /** Tool input before pending-persist and before tool execution. */
  | 'ai_gateway.tool_input';

/**
 * One guardrail invocation. `content` is the raw text the boundary handles;
 * `metadata` is provider-opaque, JSON-compatible context (slug, source kind,
 * tool name, model id, etc.). Neither field is mutated by GBrain.
 */
export interface GuardrailInput {
  hook: GuardrailHook;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * A registered guardrail backend. `classify` is awaited inline. Its return
 * value is intentionally `unknown` and intentionally ignored by GBrain — the
 * type exists only so providers can return a typed verdict to *their own*
 * logging/audit code. GBrain never reads it.
 */
export interface GuardrailProvider {
  /** Stable id for logs and dedupe (e.g. `"silmaril"`). */
  readonly id: string;
  classify(input: GuardrailInput): Promise<unknown> | unknown;
}

const providers = new Map<string, GuardrailProvider>();

/**
 * Register (or replace, by id) a guardrail provider. Idempotent per id so a
 * plugin re-init doesn't double-fire. No-op safe to call before any ingest.
 */
export function registerGuardrailProvider(provider: GuardrailProvider): void {
  if (!provider || typeof provider.classify !== 'function' || !provider.id) return;
  providers.set(provider.id, provider);
  // #3688 residual: the env loader counts registration EVENTS, not map
  // growth — a same-id replacement (explicitly supported above) keeps
  // providers.size constant and a size delta would misread it as zero.
  registrationEvents++;
}

/** Monotonic count of accepted registerGuardrailProvider calls (see above). */
let registrationEvents = 0;

/** Remove a previously-registered provider. Returns true if one was removed. */
export function unregisterGuardrailProvider(id: string): boolean {
  return providers.delete(id);
}

/** Test/whole-reset helper. Clears all registered providers. */
export function __resetGuardrailProvidersForTests(): void {
  providers.clear();
}

/** Whether any guardrail is registered. Lets hot paths skip work cheaply. */
export function hasGuardrails(): boolean {
  return providers.size > 0;
}

/**
 * Consult every registered guardrail for this boundary. Returns `void` — the
 * result is never surfaced to the caller, by design (observe-only invariant).
 *
 * Fail-open: a provider that throws or rejects is isolated; its failure is
 * swallowed so the ingest/inference/tool path proceeds unchanged. Empty/blank
 * content short-circuits before any provider runs.
 *
 * Inline await: when guardrails are registered, the caller awaits this. The
 * cost is bounded by each provider's own timeout discipline; GBrain does not
 * impose one here so providers can tune per-deployment latency budgets.
 */
/**
 * Thrown by {@link loadGuardrailProvidersFromEnv} when GBRAIN_GUARDRAILS_MODULE
 * is SET but unusable. Deliberately fail-CLOSED (unlike the classify path,
 * which fails open): an operator who configured a guardrail module expects a
 * firewall to be standing — silently running without it would defeat the
 * point. Callers (cli.ts) abort the process on this error.
 */
export class GuardrailLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailLoadError';
  }
}

export interface GuardrailEnvLoadResult {
  /** Providers registered by this call (0 when the env var is unset). */
  loaded: number;
  /** The module specifier that was loaded, or null when unset. */
  modulePath: string | null;
}

/**
 * #3688 — the operator wiring path. Loads guardrail providers from the module
 * named by `GBRAIN_GUARDRAILS_MODULE`: an ABSOLUTE file path or a `~/` path.
 * Accepted module shapes, all additive:
 *
 *   - `export default provider` (a single {@link GuardrailProvider})
 *   - `export default [providerA, providerB]`
 *   - `export const guardrailProviders = [...]`
 *   - `export function register(registerGuardrailProvider) { ... }` (sync or async)
 *
 * Unset env var → no-op (the OSS distribution stays inert). Set-but-broken —
 * import failure, or a module that registers zero providers — throws
 * {@link GuardrailLoadError} (fail-closed; see class doc).
 *
 * Origin checks (all throw {@link GuardrailLoadError} BEFORE any import):
 *   - cwd-relative specs (`./x`, `../x`, bare `.`) are refused — they would
 *     resolve against whatever directory the process happens to run in.
 *   - bare package specifiers (`some-pkg`, `@scope/pkg`, `pkg/sub`) are
 *     refused — in the compiled binary Bun's module walk-up starts at the
 *     CURRENT DIRECTORY, so a hostile checkout's `node_modules/<name>/` is
 *     what would load. Only an absolute or `~/` path names a module the
 *     operator chose.
 *   - when `env` is `process.env` (or `opts.cwd` is given), a spec that a cwd
 *     `.env` file assigns is refused whatever its value: Bun auto-loads those
 *     files and expands `${VAR}` inside them, so a cloned repository could
 *     otherwise pick the module. The CLI already quarantines the variable at
 *     startup (`cli-preflight.ts` → `env-trust.ts`); this is belt-and-braces
 *     for `gbrain/core/guardrails` library callers. `opts.skipCwdCheck` is
 *     for the one legitimate collision — the cwd IS the operator's config
 *     dir, so the "cwd .env" is `~/.gbrain/.env` itself (preflight decides).
 */
export async function loadGuardrailProvidersFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { cwd?: string; skipCwdCheck?: boolean } = {},
): Promise<GuardrailEnvLoadResult> {
  const spec = env.GBRAIN_GUARDRAILS_MODULE?.trim();
  if (!spec) return { loaded: 0, modulePath: null };

  if (spec.startsWith('.')) {
    throw new GuardrailLoadError(
      `GBRAIN_GUARDRAILS_MODULE=${spec} is a cwd-relative path and is not loaded; ` +
      `use an absolute path or a ~/ path.`,
    );
  }
  const homePath = spec.startsWith('~/') || spec.startsWith('~\\');
  if (!homePath && !isAbsolute(spec)) {
    throw new GuardrailLoadError(
      `GBRAIN_GUARDRAILS_MODULE=${spec} must be an absolute path or a ~/ path (package names ` +
      `resolve from the current directory's node_modules and are not loaded).`,
    );
  }
  if (!opts.skipCwdCheck && (env === process.env || opts.cwd !== undefined) &&
      cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', opts.cwd)) {
    throw new GuardrailLoadError(
      'GBRAIN_GUARDRAILS_MODULE is assigned by a .env file in the current directory and is ' +
      `not loaded — ${CWD_DOTENV_REMEDIATION}`,
    );
  }

  // Import via file:// URL so the spec is taken literally rather than
  // resolved against this module's location.
  const target = pathToFileURL(resolve(homePath ? homedir() + spec.slice(1) : spec)).href;

  // #3688 residual: snapshot BEFORE the import, not after. A module that
  // registers its providers as a top-level side effect (calling
  // registerGuardrailProvider at import time) does so DURING the import —
  // an after-import baseline counted those registrations as zero and the
  // fail-closed zero-provider check below then rejected a module whose
  // guardrails were in fact registered and active. Counting EVENTS (not
  // providers.size) also keeps a same-id replacement — supported by
  // registerGuardrailProvider — from reading as zero.
  const before = registrationEvents;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new GuardrailLoadError(
      `GBRAIN_GUARDRAILS_MODULE=${spec} failed to load: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  const candidates: unknown[] = [];
  if (Array.isArray(mod.default)) candidates.push(...mod.default);
  else if (mod.default) candidates.push(mod.default);
  if (Array.isArray(mod.guardrailProviders)) candidates.push(...(mod.guardrailProviders as unknown[]));
  for (const c of candidates) {
    registerGuardrailProvider(c as GuardrailProvider);
  }
  if (typeof mod.register === 'function') {
    await (mod.register as (r: typeof registerGuardrailProvider) => unknown)(registerGuardrailProvider);
  }

  const loaded = registrationEvents - before;
  if (loaded <= 0) {
    throw new GuardrailLoadError(
      `GBRAIN_GUARDRAILS_MODULE=${spec} loaded but registered no guardrail provider ` +
      `(expected a default-exported provider, a provider array, a guardrailProviders ` +
      `export, or a register() function).`,
    );
  }
  return { loaded, modulePath: spec };
}

export async function runGuardrails(input: GuardrailInput): Promise<void> {
  if (providers.size === 0) return;
  const content = typeof input.content === 'string' ? input.content : '';
  if (!content.trim()) return;

  // Snapshot so a provider registering/unregistering mid-flight can't mutate
  // the iteration set.
  const snapshot = Array.from(providers.values());
  await Promise.all(
    snapshot.map(async (provider) => {
      try {
        await provider.classify({
          hook: input.hook,
          content,
          metadata: input.metadata,
        });
      } catch {
        // Fail open. A guardrail provider MUST NOT be able to break GBrain.
        // Provider-side logging is the provider's responsibility; GBrain does
        // not log raw content here (could itself leak the classified payload).
      }
    }),
  );
}
