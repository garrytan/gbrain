/**
 * Runtime knobs read directly with `engine.getConfig()` (#6780), registered
 * so `gbrain config set` accepts them without --force. Spread into
 * KNOWN_CONFIG_KEYS (config.ts); test/config-reader-keys-registered.test.ts
 * fails when a src/ reader names a key that is neither registered nor
 * recorded as internal state.
 */
export const RUNTIME_READER_CONFIG_KEYS: readonly string[] = [
  'embed.max_usd_per_page', // page-embedding-budget.ts: large-page embedding cap, default $2 (unlimited under spend.posture tokenmax)
  'embed.content_drift.pass_interval_hours', // content-drift-sweep.ts: hours between completed content-drift passes, default 24 (0 = every run)
  'facts.absorb_warn_threshold', // doctor facts_extraction_health absorb-refusal warn threshold, default 10 per 24 h
  'think.trajectory_enabled', // think/index.ts: trajectory substrate on temporal intents, default on
  'embedding_image_ocr_max_images', 'embedding_image_ocr_max_usd', // import-file.ts image-OCR per-run caps, default 200 images / $1
  'agent.search_snippet_chars', // ops/search.ts subagent snippet cap, default 300 (0 = full text)
  'skillopt.allowed_skills', // JSON array of skills remote callers may optimize (ops/skillopt.ts, shared-skills/optimizer.ts); default deny-all
  'skillopt.capture_enabled', // skillopt/held-out.ts production rollout capture, default off
  'entity_identity.union', // entity-identity.ts: links/backlinks union across identity co-members, default off
  'writer.lint_on_put_page', // output/post-write.ts lint after put_page, default off
  'context.hot_memory.session_only', // facts/meta-hook.ts, read by the turn_context and context_pack IPC handlers: hot memory never falls back to other sessions' facts, default off
  'serve.cli_socket', // config.ts loadConfigWithEngine (snapshot only) → serve.ts: a Postgres serve answers CLI reads over a private Unix socket, default off
];
