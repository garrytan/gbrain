#!/usr/bin/env ruby
# Export a sanitized, tracked audit bundle for Dreams session-owner reports.

require "digest"
require "fileutils"
require "json"
require "optparse"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  inventory: nil,
  ledger: nil,
  output: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: export-session-audit.rb --session PATH [--brain PATH] [--inventory PATH] [--ledger PATH] [--output PATH]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--inventory PATH", "Inventory JSON path") { |value| options[:inventory] = value }
  parser.on("--ledger PATH", "Review ledger JSONL path") { |value| options[:ledger] = value }
  parser.on("--output PATH", "Audit bundle output path") { |value| options[:output] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

brain = File.expand_path(options[:brain])
session = File.expand_path(options[:session])
session_id = File.basename(session)
inventory_path = File.expand_path(options[:inventory] || File.join(session, "inventory.json"))
ledger_path = File.expand_path(options[:ledger] || File.join(brain, "inbox", "review-ledger.jsonl"))
assignments_path = File.join(session, "session-owner", "assignments.json")
output_path = File.expand_path(options[:output] || File.join(brain, "archive", "dreams-session-audits", session_id, "session-owner-audit.json"))

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "inventory not found: #{inventory_path}" unless File.file?(inventory_path)
abort "assignments not found: #{assignments_path}" unless File.file?(assignments_path)

def repo_relative(path, brain)
  value = path.to_s
  return value if value.empty?

  expanded = value.start_with?(File::SEPARATOR) ? File.expand_path(value) : File.expand_path(value, brain)
  prefix = "#{brain}#{File::SEPARATOR}"
  return expanded.delete_prefix(prefix) if expanded.start_with?(prefix)

  value.start_with?(File::SEPARATOR) ? "[REDACTED_LOCAL_PATH]" : value
end

def sanitize(value, brain)
  case value
  when Hash
    value.each_with_object({}) do |(key, item), memo|
      memo[key.to_s] = sanitize(item, brain)
    end
  when Array
    value.map { |item| sanitize(item, brain) }
  when String
    repo_relative(value, brain)
      .gsub(%r{/Users/[^/\s]+/[^\s)"'<>`\]]+}, "[REDACTED_LOCAL_PATH]")
      .gsub(%r{/home/[^/\s]+/[^\s)"'<>`\]]+}, "[REDACTED_LOCAL_PATH]")
  else
    value
  end
end

def resolve_repo_path(path, brain)
  value = path.to_s
  return value if value.empty? || value.start_with?(File::SEPARATOR)

  File.expand_path(value, brain)
end

def select_report_fields(report)
  keys = %w[
    session_id
    agent_id
    source_paths
    source_snapshot_paths
    expected_review_units
    covered_review_units
    memory_units
    draft_decision
    preservation_mode
    target_recommendations
    coverage_notes
    written_at
  ]
  keys.each_with_object({}) { |key, memo| memo[key] = report[key] if report.key?(key) }
end

inventory = JSON.parse(File.read(inventory_path))
assignments = JSON.parse(File.read(assignments_path))
session_rel = repo_relative(session, brain)
ledger_rows = []
if File.file?(ledger_path)
  File.readlines(ledger_path, chomp: true).each do |line|
    next if line.strip.empty?

    row = JSON.parse(line)
    ledger_rows << row if row["session"].to_s == session_rel
  end
end
ledger_by_source = ledger_rows.to_h { |row| [row["source_path"].to_s, row] }

tasks = Array(assignments["tasks"]).map do |task|
  report_path = task["report_path"].to_s
  report_file_path = resolve_repo_path(report_path, brain)
  report = File.file?(report_file_path) ? JSON.parse(File.read(report_file_path)) : {}
  report_sha = File.file?(report_file_path) ? Digest::SHA256.hexdigest(File.read(report_file_path)) : nil
  source_paths = Array(task["source_paths"]).map(&:to_s)
  row = source_paths.lazy.map { |path| ledger_by_source[path] }.find { |candidate| candidate }

  {
    "session_id" => task["session_id"],
    "agent_id" => task["agent_id"],
    "assignment_status" => task["assignment_status"],
    "assigned_at" => task["assigned_at"],
    "report_path" => repo_relative(report_path, brain),
    "report_sha256" => report_sha,
    "source_paths" => source_paths,
    "source_snapshot_paths" => Array(task["source_snapshot_paths"]).map { |path| repo_relative(path, brain) },
    "expected_review_units" => Array(task["expected_review_units"]),
    "report" => sanitize(select_report_fields(report), brain),
    "ledger_binding" => row ? {
      "source_path" => row["source_path"],
      "sha256" => row["sha256"],
      "archived_path" => row["archived_path"],
      "decision" => row["decision"],
      "preservation_mode" => row["preservation_mode"],
      "targets" => Array(row["targets"]),
      "session_owner_report" => sanitize(row["session_owner_report"] || {}, brain),
      "memory_unit_count" => Array(row["memory_units"]).size
    } : nil
  }
end

audit = {
  "schema" => "dreams-session-owner-audit.v1",
  "session" => session_rel,
  "inventory" => repo_relative(inventory_path, brain),
  "assignments" => repo_relative(assignments_path, brain),
  "ledger" => File.file?(ledger_path) ? repo_relative(ledger_path, brain) : nil,
  "inventory_total" => Array(inventory["drafts"]).size,
  "session_owner_task_count" => tasks.size,
  "ledger_row_count" => ledger_rows.size,
  "tasks" => tasks
}

serialized = JSON.pretty_generate(audit) + "\n"
if serialized.include?(brain) || serialized.match?(%r{/Users/[^/\s]+/}) || serialized.match?(%r{/home/[^/\s]+/})
  abort "sanitized audit still contains local absolute paths"
end

FileUtils.mkdir_p(File.dirname(output_path))
File.write(output_path, serialized)

puts JSON.generate({
  ok: true,
  session: session_rel,
  output: repo_relative(output_path, brain),
  session_owner_task_count: tasks.size,
  ledger_row_count: ledger_rows.size
})
