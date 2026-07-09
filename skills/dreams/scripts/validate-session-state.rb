#!/usr/bin/env ruby
# Validate terminal state/report artifacts for a dreams session.

require "json"
require "open3"
require "optparse"
require "pathname"
require "time"

require_relative "review_session_counts"
require_relative "post_inventory_inbox_audit"
require_relative "proposal_audit"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  ledger: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: validate-session-state.rb --session PATH [--brain PATH] [--ledger PATH]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Review session path") { |value| options[:session] = value }
  parser.on("--ledger PATH", "Applied review ledger JSONL path") { |value| options[:ledger] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

brain = File.expand_path(options[:brain])
session = File.expand_path(options[:session])
ledger_path = File.expand_path(options[:ledger] || File.join(brain, "inbox", "review-ledger.jsonl"))
state_path = File.join(session, "state.json")
inventory_path = File.join(session, "inventory.json")
summary_path = File.join(session, "reports", "SUMMARY.md")
proposal_ledger_path = File.join(session, "proposals", "review-ledger.jsonl")
assignments_path = File.join(session, "session-owner", "assignments.json")

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "session not found: #{session}" unless Dir.exist?(session)
abort "state.json not found: #{state_path}" unless File.file?(state_path)
abort "inventory.json not found: #{inventory_path}" unless File.file?(inventory_path)
abort "SUMMARY.md not found: #{summary_path}" unless File.file?(summary_path)

def session_keys(session, brain)
  relative = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
  [session, relative].compact.uniq
end

def session_ledger_rows(path, keys)
  return nil unless File.file?(path)

  rows = []
  File.foreach(path) do |line|
    next if line.strip.empty?

    row = JSON.parse(line)
    rows << row if keys.include?(row["session"].to_s)
  rescue JSON::ParserError
    raise "invalid JSONL row in #{path}"
  end
  rows
end

def markdown_section(text, heading)
  lines = text.lines
  start = lines.find_index { |line| line.strip == heading }
  return nil unless start

  collected = []
  lines[(start + 1)..].to_a.each do |line|
    break if line.match?(/\A##\s+/)

    collected << line
  end
  collected.join
end

def parse_summary_counts(summary)
  section = markdown_section(summary, "## Counts")
  return [nil, "SUMMARY.md ## Counts must include a fenced json count block"] if section.nil?

  match = section.match(/```json\s*(\{.*?\})\s*```/m)
  return [nil, "SUMMARY.md ## Counts must include a fenced json count block"] unless match

  parsed = JSON.parse(match[1])
  [parsed, nil]
rescue JSON::ParserError => error
  [nil, "SUMMARY.md count json is invalid: #{error.message}"]
end

def iso8601?(value)
  Time.iso8601(value.to_s)
  true
rescue ArgumentError
  false
end

def validate_session_owner_reports(session, inventory_path)
  validator = File.expand_path("validate-session-owner-reports.rb", __dir__)
  output, status = Open3.capture2e(
    "ruby",
    validator,
    "--session",
    session,
    "--inventory",
    inventory_path
  )
  status.success? ? nil : "session-owner report validation failed: #{output.strip}"
end

def session_owner_task_count(assignments_path)
  return 0 unless File.file?(assignments_path)

  assignments = JSON.parse(File.read(assignments_path))
  Array(assignments["tasks"]).size
rescue JSON::ParserError
  0
end

def validate_session_audit_bundle(brain, session, inventory_total, expected_task_count, expected_ledger_rows)
  return [] if expected_task_count <= 0

  session_id = File.basename(session)
  session_rel = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
  audit_path = File.join(brain, "archive", "dreams-session-audits", session_id, "session-owner-audit.json")
  errors = []
  unless File.file?(audit_path)
    return ["session-owner audit bundle missing: archive/dreams-session-audits/#{session_id}/session-owner-audit.json"]
  end

  text = File.read(audit_path)
  if text.include?(brain) || text.match?(%r{/Users/[^/\s]+/}) || text.match?(%r{/home/[^/\s]+/})
    errors << "session-owner audit bundle must not contain local absolute paths"
  end

  audit = JSON.parse(text)
  errors << "session-owner audit bundle schema is invalid" unless audit["schema"] == "dreams-session-owner-audit.v1"
  errors << "session-owner audit bundle session must match review session" unless audit["session"].to_s == session_rel.to_s
  errors << "session-owner audit bundle inventory_total must match inventory.total" unless audit["inventory_total"] == inventory_total
  errors << "session-owner audit bundle task count must match assignments" unless audit["session_owner_task_count"] == expected_task_count
  errors << "session-owner audit bundle ledger row count must match session ledger rows" unless audit["ledger_row_count"] == expected_ledger_rows
  errors << "session-owner audit bundle tasks length must match assignments" unless Array(audit["tasks"]).size == expected_task_count
  errors
rescue JSON::ParserError => error
  ["session-owner audit bundle JSON is invalid: #{error.message}"]
end

state = JSON.parse(File.read(state_path))
inventory = JSON.parse(File.read(inventory_path))
summary = File.read(summary_path)
errors = []

inventory_total = inventory["total"]
counts = state["counts"]
mode = state["mode"]
post_inventory_audit = state["post_inventory_inbox_audit"]
session_match_keys = session_keys(session, brain)

errors << "state.active must be false" unless state["active"] == false
errors << "state.phase must be done" unless state["phase"] == "done"
errors << "state.completed_at must be ISO8601" unless iso8601?(state["completed_at"])
errors << "state.mode must be an object" unless mode.is_a?(Hash)
errors << "state.counts must be an object" unless counts.is_a?(Hash)
errors << "inventory.total must be an integer" unless inventory_total.is_a?(Integer)
session_owner_error = validate_session_owner_reports(session, inventory_path)
errors << session_owner_error if session_owner_error
owner_task_count = session_owner_task_count(assignments_path)

if mode.is_a?(Hash)
  ReviewDraftsSessionCounts::REQUIRED_MODE_FLAGS.each do |flag|
    errors << "state.mode.#{flag} must be boolean" unless [true, false].include?(mode[flag])
  end
end

if counts.is_a?(Hash) && inventory_total.is_a?(Integer)
  errors << "counts.inventory_total must equal inventory.total" unless counts["inventory_total"] == inventory_total
  errors << "counts.handled_total must equal inventory.total" unless counts["handled_total"] == inventory_total

  decision_sum = ReviewDraftsSessionCounts.count_map_sum(counts["by_decision"], ReviewDraftsSessionCounts::ALLOWED_DECISIONS)
  mode_sum = ReviewDraftsSessionCounts.count_map_sum(counts["by_preservation_mode"], ReviewDraftsSessionCounts::ALLOWED_MODES)
  score_sum = ReviewDraftsSessionCounts.count_map_sum(counts["score_bands"], ReviewDraftsSessionCounts::ALLOWED_SCORE_BANDS)

  errors << "counts.by_decision must use allowed decisions and sum to inventory.total" unless decision_sum == inventory_total
  errors << "counts.by_preservation_mode must use allowed modes and sum to inventory.total" unless mode_sum == inventory_total
  errors << "counts.score_bands must use allowed bands and sum to inventory.total" unless score_sum == inventory_total
end

post_inventory_errors = DreamsPostInventoryInboxAudit.validate_state_audit(post_inventory_audit)
errors.concat(post_inventory_errors)
summary_audit_counts, summary_audit_error = DreamsPostInventoryInboxAudit.summary_counts(summary)
if summary_audit_error
  errors << summary_audit_error
elsif post_inventory_audit.is_a?(Hash) && post_inventory_audit["counts"].is_a?(Hash)
  if summary_audit_counts != post_inventory_audit["counts"]
    errors << "SUMMARY.md post-inventory audit count json must exactly match state.post_inventory_inbox_audit.counts"
  end
end

summary_counts, summary_counts_error = parse_summary_counts(summary)
if summary_counts_error
  errors << summary_counts_error
elsif counts.is_a?(Hash)
  expected_summary_counts = ReviewDraftsSessionCounts.canonical_counts(counts)
  if summary_counts != expected_summary_counts
    errors << "SUMMARY.md count json must exactly match state.counts"
  end
end

if mode.is_a?(Hash)
  dry_run = mode["dry_run"] == true
  ledger_for_rows = dry_run ? proposal_ledger_path : ledger_path
  ledger_rows = session_ledger_rows(ledger_for_rows, session_match_keys)
  ledger_rows = [] if ledger_rows.nil? && inventory_total == 0
  row_count = ledger_rows&.length

  errors << "ledger rows for session must equal inventory.total" unless row_count == inventory_total
  if !dry_run && row_count
    errors.concat(validate_session_audit_bundle(brain, session, inventory_total, owner_task_count, row_count))
  end
  if ledger_rows && counts.is_a?(Hash)
    ledger_counts, ledger_count_errors = ReviewDraftsSessionCounts.aggregate_ledger_counts(ledger_rows)
    errors.concat(ledger_count_errors)
    errors << "counts.by_decision must match ledger row decisions" unless counts["by_decision"] == ledger_counts["by_decision"]
    errors << "counts.by_preservation_mode must match ledger row preservation modes" unless counts["by_preservation_mode"] == ledger_counts["by_preservation_mode"]
    errors << "counts.score_bands must match ledger row importance score bands" unless counts["score_bands"] == ledger_counts["score_bands"]

    proposal_audit = DreamsProposalAudit.audit(brain: brain, session: session, rows: ledger_rows)
    errors.concat(DreamsProposalAudit.validate_summary(summary, proposal_audit))
  end

  if ledger_rows && post_inventory_audit.is_a?(Hash) && post_inventory_audit["checked_at"]
    applied_ledger_path = File.join(brain, "inbox", "review-ledger.jsonl")
    all_ledger_rows = DreamsPostInventoryInboxAudit.ledger_rows(applied_ledger_path)
    all_ledger_rows += ledger_rows if dry_run
    pending_ledger_rows = DreamsPostInventoryInboxAudit.boundary_pending_ledger_rows(inventory, brain)
    expected_audit = DreamsPostInventoryInboxAudit.audit(
      brain: brain,
      session: session,
      inventory: inventory,
      ledger_rows: ledger_rows,
      all_ledger_rows: all_ledger_rows,
      timestamp: post_inventory_audit["checked_at"],
      dry_run: dry_run,
      ignore_after: post_inventory_audit["checked_at"],
      pending_ledger_rows: pending_ledger_rows
    )
    if post_inventory_audit != expected_audit
      errors << "state.post_inventory_inbox_audit must match current inbox state up to checked_at"
    end
  end

  if dry_run
    errors << "dry_run mode must have apply=false" unless mode["apply"] == false
    errors << "dry_run mode must have sync=false" unless mode["sync"] == false
    errors << "dry_run mode must have commit=false" unless mode["commit"] == false
    errors << "dry_run mode must have push=false" unless mode["push"] == false
  end
end

[
  "## Counts",
  "## Post-Inventory Inbox Audit",
  "## Proposal Audit",
  "## Verification",
  "## Quality Audit Sample",
  "Unresolved blockers"
].each do |needle|
  errors << "SUMMARY.md missing #{needle}" unless summary.include?(needle)
end

if errors.any?
  warn errors.join("\n")
  abort "review session state validation failed"
end

puts JSON.generate({ ok: true, session: session, inventory_total: inventory_total })
