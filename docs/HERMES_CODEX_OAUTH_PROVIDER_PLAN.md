# Hermes/Codex OAuth provider plan

## Goal

Add a first-class GBrain chat provider, `openai-codex`, so a user who already authenticated Hermes/Codex via OpenAI OAuth can use that same local OAuth credential store for GBrain chat/subagent flows without exporting refreshable tokens as environment variables.

## Non-goals

- Do not expose or print access tokens, refresh tokens, client secrets, or raw auth files.
- Do not pretend Codex OAuth is an `OPENAI_API_KEY`.
- Do not implement embeddings via Codex OAuth. GBrain should continue to use a supported embedding provider such as local Ollama or OpenAI API-key embeddings.
- Do not mutate Hermes/Codex auth files except when refreshing with the same lock/rotation semantics required to keep OAuth usable.

## Current architecture findings

- Provider registry is static in `src/core/ai/recipes/index.ts`.
- Provider implementation choices are typed in `src/core/ai/types.ts` and switched in `src/core/ai/gateway.ts`.
- Existing native providers use Vercel AI SDK model objects; Codex backend is not a normal OpenAI API-key provider.
- Hermes resolves Codex OAuth via `hermes_cli/auth.py`:
  - client id: public Codex OAuth client id
  - token endpoint: `https://auth.openai.com/oauth/token`
  - inference base URL: `https://chatgpt.com/backend-api/codex`
  - refreshes with `grant_type=refresh_token`
  - reads Hermes auth store and may import Codex CLI tokens
- Hermes’ runtime uses the Responses API path for Codex and contains stream backfill logic because the ChatGPT Codex backend can emit output items via stream events even when final SDK output is sparse.

## Implementation design

1. Add recipe `src/core/ai/recipes/openai-codex.ts`:
   - id: `openai-codex`
   - tier: native
   - implementation: new `codex-oauth`
   - chat only
   - known model aliases such as `gpt-5.3-codex` and `gpt-5-codex`
   - `supports_tools: false` initially unless/until tool-call replay is verified
   - `supports_subagent_loop: false` initially for safety

2. Extend gateway implementation type with `codex-oauth`.

3. Add `src/core/ai/codex-oauth.ts`:
   - Locate auth in this order:
     - `GBRAIN_CODEX_AUTH_JSON` explicit file path
     - `~/.hermes/auth.json` / Hermes Codex store shape
     - `~/.codex/auth.json` / Codex CLI shape
   - Parse only shape/expiry; never log token values.
   - Refresh when access token is expiring within a skew window.
   - Use a file lock or atomic write guard to avoid token rotation races.
   - Return a Vercel-AI-SDK-compatible language model adapter for `generateText`, or a narrow internal `runCodexChat` adapter if the AI SDK contract is too heavy.

4. Gateway chat path:
   - For `recipe.implementation === 'codex-oauth'`, route through custom Codex Responses API adapter rather than `createOpenAI` or `createOpenAICompatible`.
   - Convert GBrain `ChatMessage[]` to Responses API `input`.
   - Support plain text chat first.
   - Reject tool-calling requests with clear `AIConfigError` until stable tool semantics are implemented.

5. CLI/provider UX:
   - `gbrain config set chat_model openai-codex:gpt-5.3-codex` should work.
   - `gbrain providers list/explain` should show `openai-codex` as chat-only.
   - `gbrain providers env openai-codex` should explain OAuth reuse and not ask for `OPENAI_API_KEY`.

6. Test strategy:
   - Unit tests for recipe registry/resolver/isAvailable.
   - Unit tests for token redaction/no-token-in-error behavior.
   - Unit tests for auth shape parsing with fake tokens only.
   - Unit tests for refresh request construction using mocked fetch/http; no real token values.
   - Smoke test with real local credentials only behind an opt-in env flag, never in CI by default.

## First safe increment

Ship the provider recipe, auth-loader parser, refresh logic tests, and gateway availability plumbing first. Then add the live Codex Responses adapter once the provider is discoverable and safe. This keeps the fork reviewable and prevents OAuth leakage while we validate the protocol surface.
