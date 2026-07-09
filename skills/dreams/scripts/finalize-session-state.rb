#!/usr/bin/env ruby
# Finalize dreams state/report counts from the session ledger.

require "json"
require "fileutils"
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
  ledger: nil,
  timestamp: Time.now.iso8601
}

OptionParser.new do |parser|
  parser.banner = "Usage: finalize-session-state.rb --session PATH [--brain PATH] [--ledger PATH] [--timestamp ISO8601]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Review session path") { |value| options[:session] = value }
  parser.on("--ledger PATH", "Review ledger JSONL path") { |value| options[:ledger] = value }
  parser.on("--timestamp ISO8601", "Completion timestamp") { |value| options[:timestamp] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

brain = File.expand_path(options[:brain])
session = File.expand_path(options[:session])
state_path = File.join(session, "state.json")
inventory_path = File.join(session, "inventory.json")
summary_path = File.join(session, "reports", "SUMMARY.md")
proposal_ledger_path = File.join(session, "proposals", "review-ledger.jsonl")

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "session not found: #{session}" unless Dir.exist?(session)
abort "state.json not found: #{state_path}" unless File.file?(state_path)
abort "inventory.json not found: #{inventory_path}" unless File.file?(inventory_path)

def session_keys(session, brain)
  relative = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
  [session, relative].compact.uniq
end

def session_ledger_rows(path, keys, allow_missing: false)
  return [] if allow_missing && !File.file?(path)
  abort "ledger not found: #{path}" unless File.file?(path)

  rows = []
  File.foreach(path).with_index(1) do |line, lineno|
    next if line.strip.empty?

    row = JSON.parse(line)
    rows << [lineno, row] if keys.include?(row["session"].to_s)
  rescue JSON::ParserError => error
    abort "invalid JSONL row at #{path}:#{lineno}: #{error.message}"
  end
  rows
end

def validate_ledger!(brain, session, ledger_path, inventory_path)
  validator = File.expand_path("validate-review-ledger.rb", __dir__)
  output, status = Open3.capture2e(
    "ruby",
    validator,
    "--brain",
    brain,
    "--session",
    session,
    "--ledger",
    ledger_path,
    "--inventory",
    inventory_path
  )
  return if status.success?

  warn output
  abort "review ledger validation failed; refusing to finalize session state"
end

def validate_session_owner_reports!(session, inventory_path)
  validator = File.expand_path("validate-session-owner-reports.rb", __dir__)
  output, status = Open3.capture2e(
    "ruby",
    validator,
    "--session",
    session,
    "--inventory",
    inventory_path
  )
  return if status.success?

  warn output
  abort "session-owner report validation failed; refusing to finalize session state"
end

def counts_markdown(counts)
  <<~MARKDOWN
    ## Counts

    ```json
    #{JSON.pretty_generate(counts)}
    ```
  MARKDOWN
end

def replace_or_prepend_counts(summary, counts)
  block = counts_markdown(counts)
  if summary.match?(/\A## Counts\s*$/)
    summary.sub(/\A## Counts\s*\n.*?(?=\n## |\z)/m, block.rstrip)
  elsif summary.match?(/^## Counts\s*$/)
    summary.sub(/^## Counts\s*\n.*?(?=\n## |\z)/m, block.rstrip)
  else
    "#{block}\n\n#{summary}".rstrip + "\n"
  end
end

def replace_or_insert_section(summary, heading, block, before_heading: nil)
  escaped_heading = Regexp.escape(heading)
  if summary.match?(/^#{escaped_heading}\s*$/)
    return summary.sub(/^#{escaped_heading}\s*\n.*?(?=\n## |\z)/m, block.rstrip)
  end

  if before_heading && summary.match?(/^#{Regexp.escape(before_heading)}\s*$/)
    return summary.sub(/^#{Regexp.escape(before_heading)}\s*$/, "#{block.rstrip}\n\n#{before_heading}")
  end

  "#{summary.rstrip}\n\n#{block.rstrip}\n"
end

state = JSON.parse(File.read(state_path))
inventory = JSON.parse(File.read(inventory_path))
mode = state["mode"]
abort "state.mode must be an object" unless mode.is_a?(Hash)
ReviewDraftsSessionCounts::REQUIRED_MODE_FLAGS.each do |flag|
  abort "state.mode.#{flag} must be boolean" unless [true, false].include?(mode[flag])
end
begin
  Time.iso8601(options[:timestamp])
rescue ArgumentError
  abort "--timestamp must be ISO8601"
end

inventory_total = inventory["total"]
abort "inventory.total must be an integer" unless inventory_total.is_a?(Integer)
if mode["dry_run"] == true
  %w[apply sync commit push].each do |flag|
    abort "dry_run mode must have #{flag}=false" unless mode[flag] == false
  end
end

ledger_path = File.expand_path(
  options[:ledger] || (mode["dry_run"] == true ? proposal_ledger_path : File.join(brain, "inbox", "review-ledger.jsonl"))
)
rows = session_ledger_rows(ledger_path, session_keys(session, brain), allow_missing: inventory_total.zero?)
validate_session_owner_reports!(session, inventory_path)
validate_ledger!(brain, session, ledger_path, inventory_path) unless rows.empty?
counts, count_errors = ReviewDraftsSessionCounts.final_counts(inventory_total, rows)
session_rows = rows.map { |_lineno, row| row }
applied_ledger_path = File.join(brain, "inbox", "review-ledger.jsonl")
all_ledger_rows = DreamsPostInventoryInboxAudit.ledger_rows(applied_ledger_path)
all_ledger_rows += session_rows if mode["dry_run"] == true
pending_ledger_rows = DreamsPostInventoryInboxAudit.boundary_pending_ledger_rows(inventory, brain)
post_inventory_audit = DreamsPostInventoryInboxAudit.audit(
  brain: brain,
  session: session,
  inventory: inventory,
  ledger_rows: session_rows,
  all_ledger_rows: all_ledger_rows,
  timestamp: options[:timestamp],
  dry_run: mode["dry_run"] == true,
  pending_ledger_rows: pending_ledger_rows
)

if count_errors.any?
  warn count_errors.join("\n")
  abort "cannot finalize incomplete or invalid review session"
end

proposal_audit = DreamsProposalAudit.audit(brain: brain, session: session, rows: session_rows)
if proposal_audit["missing_proposal_artifacts"].any?
  warn "missing proposed final-content artifacts: #{proposal_audit["missing_proposal_artifacts"].join(", ")}"
  abort "cannot finalize session with curated edits missing proposal artifacts"
end

state["active"] = false
state["phase"] = "done"
state["completed_at"] = options[:timestamp]
state["counts"] = counts
state["post_inventory_inbox_audit"] = post_inventory_audit
File.write(state_path, JSON.pretty_generate(state) + "\n")

FileUtils.mkdir_p(File.dirname(summary_path)) unless Dir.exist?(File.dirname(summary_path))
summary = File.file?(summary_path) ? File.read(summary_path) : "# Dreams Summary\n\n## Verification\n\n## Quality Audit Sample\n\nUnresolved blockers: none.\n"
summary = replace_or_prepend_counts(summary, counts)
summary = replace_or_insert_section(
  summary,
  "## Post-Inventory Inbox Audit",
  DreamsPostInventoryInboxAudit.markdown(post_inventory_audit),
  before_heading: "## Proposal Audit"
)
summary = replace_or_insert_section(
  summary,
  "## Proposal Audit",
  DreamsProposalAudit.markdown(proposal_audit),
  before_heading: "## Verification"
)
File.write(summary_path, summary)

puts JSON.generate({ ok: true, session: session, ledger: ledger_path, counts: counts })
