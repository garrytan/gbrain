/**
 * Runtime knobs read directly with `engine.getConfig()` (#6780), registered
 * so `gbrain config set` accepts them without --force. Spread into
 * KNOWN_CONFIG_KEYS (config.ts); test/config-reader-keys-registered.test.ts
 * fails when a src/ reader names a key that is neither registered nor
 * recorded as internal state.
 */
export const RUNTIME_READER_CONFIG_KEYS: readonly string[] = [
  'engine.rust.multiuser', // rust-engine/multiuser-switch.ts (I-0): the brain's own multi-user Rust switch, true or 1 = on, read by the store at open; default off
  'apple.helper.port', // imessage/imessage-source.ts: the GBrain Helper's loopback port an imessage source reads (set by setup; no default)
  'dedupe.exa', 'dedupe.exa_run_cap', 'dedupe.exa_total_cap_usd', // entities/evidence/exa.ts (GST-3609): web search for gbrain dedupe classes/sample --exa, off unless on and EXA_API_KEY is set; queries per run, default 2000; total spend cap in USD, default 25
  'google_contacts.identity_links', // google/contact-identity.ts (GST-3609): on = each Google sync links the contacts it changed by exact email or phone; set by gbrain dedupe link-contacts --apply / --unlink, default off
  'identity.phone_country_code', // phone-key.ts, read by ops/whois.ts and apple-contacts/apple-contacts-source.ts: country code for phone numbers written without one, default 1
  'apple_contacts.write', 'apple_contacts.destructive_writes', 'apple_contacts.owner_key_file', // commands/apple-contacts.ts (GST-3278): write switch off|dry_run|on and destructive switch, both default off; absolute path of the 0600 owner key file
  'apple_contacts.enrich', 'apple_contacts.write_token_file', 'apple_contacts.enrich.create_cards', // apple-contacts/enrich.ts (GST-3278 PR 2): enrichment after each pull off|dry_run|on, default off; absolute path of the 0600 write:contacts:enrich token file; new cards from Google Contacts, default false
  'embed.max_usd_per_page', // page-embedding-budget.ts: large-page embedding cap, default $2 (unlimited under spend.posture tokenmax)
  'derive.max_usd_per_page', // page-spend.ts: large-page cap per paid derivation (facts, synopsis), default $2 (unlimited under spend.posture tokenmax)
  'embed.content_drift.pass_interval_hours', // content-drift-sweep.ts: hours between completed content-drift passes, default 24 (0 = every run)
  'facts.absorb_warn_threshold', // doctor facts_extraction_health absorb-refusal warn threshold, default 10 per 24 h
  'think.trajectory_enabled', // think/index.ts: trajectory substrate on temporal intents, default on
  'think.remote_models', // ops/takes.ts (GBRA-437): comma-separated models a remote think may pick; default empty, so remote callers get the host think model
  'cycle.propose_takes.budget_usd', 'cycle.grade_takes.budget_usd', 'cycle.calibration_profile.budget_usd', // cycle/base-phase.ts: per-run USD caps of the calibration phases, 0 spends nothing (GST-3490)
  'cycle.grade_takes.auto_resolve.enabled', // cycle/grade-takes.ts: apply verdicts at or above the 0.95 confidence threshold, default off (#7542)
  'embedding_image_ocr_max_images', 'embedding_image_ocr_max_usd', // import-file.ts image-OCR per-run caps, default 200 images / $1
  'agent.search_snippet_chars', // ops/search.ts subagent snippet cap, default 300 (0 = full text)
  'skillopt.allowed_skills', // JSON array of skills remote callers may optimize (ops/skillopt.ts, shared-skills/optimizer.ts); default deny-all
  'skillopt.capture_enabled', // skillopt/held-out.ts production rollout capture, default off
  'entity_identity.union', // entity-identity.ts: links/backlinks union across identity co-members, default off
  'writer.lint_on_put_page', // output/post-write.ts lint after put_page, default off
  'context.hot_memory.session_only', // facts/meta-hook.ts, read by the turn_context and context_pack IPC handlers: hot memory never falls back to other sessions' facts, default off
  'serve.cli_socket', // config.ts loadConfigWithEngine (snapshot only) → serve.ts: a Postgres serve answers CLI reads over a private Unix socket, default off
  'sources.refresh_fetch_timeout_ms', 'sources.refresh_drain_wait_ms', // persistence/worktree-refresh.ts: refresh fetch bound (default 120 s) and drain wait (default 60 s), in ms
  'sources.refresh_publish_diverged', // persistence/worktree-refresh.ts (#7686): refresh publishes a diverged checkout's local commits merged with the upstream before fast-forwarding; unset = on when Git durability is on
  'serve.vector_prewarm', // config.ts loadConfigWithEngine (snapshot only) → serve.ts: a Postgres serve prewarms the HNSW indexes into shared_buffers at start when they fit, default off
  'mcp.stdio_member', // access/caller.ts (GBRA-218): binds a local stdio MCP server to one member; unbound, stdio reads no page that names readers
  'persistence.adopt_quiet_ms', // persistence/local-edit-adoption.ts (GST-1601): how long a local edit must be quiet before it is adopted, default 5000
  'access.owner_member', // access/owner.ts (GST-2059): the member who owns this brain; credentials bound to it read private pages (gbrain access owner set)
  'access.owner_reads_restricted', // access/owner.ts (GST-2490): '1' lets owner-bound credentials read past readers lists and rules (gbrain access owner reads-restricted on)
  'access.members_read_lineage', // access/lineage.ts (GBRA-108 design 3): '1' lets a member read derived pages and facts of origins it reads (gbrain access members-read-lineage on)
  'access.serves', // access/serves.ts (GST-363): one or several; explicit wins over the enabled-member count (gbrain setup --serves several writes it)
  'access.enforced_member_writes', // cli/enforced-member.ts (GST-2675): refuse makes GBRAIN_ENFORCED_MEMBER refuse every member write; unset or checked = writes checked as today; any other value or a failed read refuses
  'access.requester_scope_enforce', // access/requester-scope.ts (GST-363): false turns the unscoped-read refusal on a brain that serves several people into a notice (hosted, until connections are bound); default on
  'mcp.stdio_may_act_for', // access/audience.ts (GBRA-231): whom a local stdio server may act for (_meta.on_behalf_of); unset, stdio refuses every audience
  'proposals.ttl_hours', 'proposals.max_pending_per_actor', 'proposals.max_pending_per_credential', // persistence/memory-proposals.ts: held QM proposal TTL (168 h) and pending caps (10 per person, 50 per credential)
  'transcripts.archive.enabled', 'transcripts.archive.source', 'transcripts.archive.timezone', // transcripts/archive.ts (GST-2768): the conversation archive switch (gbrain transcripts archive on|off), its source (default conversations) and the timezone its days are cut in (pinned per source on the first run)
  'transcripts.archive.backfill_days_per_run', 'transcripts.archive.run_window_days', 'transcripts.archive.quiet_minutes', // transcripts/archive.ts: days one backfill run writes, days a run re-reads, and minutes of quiet before an open day embeds
  'transcripts.archive.maintenance_floor_min', 'transcripts.archive.stale_days', // transcripts/archive-maintenance.ts (GST-2768 PR 3): minutes between maintenance-pass archive runs (360) and days behind before doctor transcript_archive_freshness warns (2)
  'proposals.retention_days', 'proposals.max_payload_chars', 'proposals.max_reason_chars', // persistence/memory-proposals.ts: closed-row retention (30 d), payload (1,000) and deny-reason (500) character caps
];
