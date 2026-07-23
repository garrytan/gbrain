#!/usr/bin/env ruby
# Validate that every Dreams session-owner task has an assigned subagent and a complete report.

require "json"
require "digest"
require "optparse"
require "time"

options = {
  session: nil,
  inventory: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: validate-session-owner-reports.rb --session PATH [--inventory PATH]"
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--inventory PATH", "Inventory JSON path") { |value| options[:inventory] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

session = File.expand_path(options[:session])
inventory_path = File.expand_path(options[:inventory] || File.join(session, "inventory.json"))
assignments_path = File.join(session, "session-owner", "assignments.json")
brain = if session.include?("#{File::SEPARATOR}.dreams#{File::SEPARATOR}")
          session.split("#{File::SEPARATOR}.dreams#{File::SEPARATOR}", 2).first
        else
          File.dirname(File.dirname(session))
        end

abort "inventory not found: #{inventory_path}" unless File.file?(inventory_path)

ALLOWED_DECISIONS = %w[promoted low-confidence-promoted source-note discarded duplicate blocked-safety].freeze
ALLOWED_MODES = %w[preserve-full preserve-substantial synthesize source-note discard duplicate blocked-safety].freeze
ALLOWED_UNIT_STATUSES = %w[reviewed discarded duplicate unsafe blocked].freeze
ALLOWED_UNIT_KINDS = %w[authored-thinking business-idea strategy decision preference project-fact gotcha person-context company-context meeting-event operational-evidence source-evidence status-noise duplicate unsafe other-durable other-ephemeral].freeze
TASK_MUTABLE_KEYS = %w[agent_id assigned_at assignment_status task_sha256 prompt_sha256 assignment_event_sha256].freeze

def present?(value)
  !value.nil? && !value.to_s.strip.empty?
end

def cyrillic?(value)
  value.to_s.match?(/\p{Cyrillic}/)
end

def english_only!(errors, prefix, label, value)
  errors << "#{prefix}: #{label} must be English-only" if cyrillic?(value)
end

def iso8601?(value)
  Time.iso8601(value.to_s)
  true
rescue ArgumentError
  false
end

def canonical_task_sha(task)
  stable = task.reject { |key, _value| TASK_MUTABLE_KEYS.include?(key.to_s) }
  Digest::SHA256.hexdigest(JSON.pretty_generate(stable) + "\n")
end

def assignment_event_sha(task)
  Digest::SHA256.hexdigest([
    task["session_id"],
    task["agent_id"],
    task["assigned_at"],
    task["task_sha256"],
    task["prompt_sha256"]
  ].join("\n"))
end

def review_unit_records(group)
  source_paths = Array(group["drafts"]).map(&:to_s)
  source_paths = [""] if source_paths.empty?
  segment_manifest = Array(group["segment_manifest"])
  if segment_manifest.any?
    raw_records = segment_manifest.map do |segment|
      source_path = segment["source_path"].to_s
      source_path = source_paths.first if source_path.empty?
      {
        "source_path" => source_path,
        "segment_id" => segment["segment_id"].to_s,
        "segment_sha256" => segment["sha256"].to_s,
        "source_anchor" => segment["source_anchor"].to_s
      }
    end
    duplicate_segment_ids = raw_records.map { |record| record["segment_id"] }.select { |id| raw_records.count { |record| record["segment_id"] == id } > 1 }.uniq
    multi_source = raw_records.map { |record| record["source_path"] }.uniq.length > 1
    return raw_records.map do |record|
      source_index = source_paths.index(record["source_path"]) || 0
      unit_id = if multi_source || duplicate_segment_ids.include?(record["segment_id"])
                  "draft-#{source_index + 1}:#{record["segment_id"]}"
                else
                  record["segment_id"]
                end
      record.merge("unit_id" => unit_id)
    end
  end

  count = group["draft_count"].to_i
  count = source_paths.length if count <= 0
  count = 1 if count <= 0
  (1..count).map do |index|
    {
      "unit_id" => "draft-#{index}",
      "source_path" => source_paths[index - 1].to_s,
      "segment_id" => nil,
      "segment_sha256" => nil,
      "source_anchor" => "draft-#{index} full draft"
    }
  end
end

def expected_units_for_group(group)
  review_unit_records(group).map { |unit| unit["unit_id"] }
end

def task_label(task)
  task["session_id"].to_s.empty? ? "(unknown-session)" : task["session_id"].to_s
end

def resolve_repo_path(path, brain)
  value = path.to_s
  return value if value.empty? || value.start_with?(File::SEPARATOR)

  File.expand_path(value, brain)
end

def resolved_paths(values, brain)
  Array(values).map { |value| resolve_repo_path(value, brain) }
end

inventory = JSON.parse(File.read(inventory_path))
errors = []

expected_session_ids = Array(inventory["session_groups"]).map { |group| group["session_id"].to_s }.reject(&:empty?).sort
unless File.file?(assignments_path)
  if expected_session_ids.empty?
    puts JSON.generate({ ok: true, session: session, session_owner_tasks: 0, reports: [] })
    exit 0
  end

  abort "session-owner assignments not found: #{assignments_path}"
end

assignments = JSON.parse(File.read(assignments_path))
tasks = Array(assignments["tasks"])
task_session_ids = tasks.map { |task| task["session_id"].to_s }.reject(&:empty?).sort
agent_ids = tasks.map { |task| task["agent_id"].to_s }.reject(&:empty?)
duplicate_agent_ids = agent_ids.select { |agent_id| agent_ids.count(agent_id) > 1 }.uniq

missing_tasks = expected_session_ids - task_session_ids
extra_tasks = task_session_ids - expected_session_ids
errors << "#{assignments_path}: missing session-owner tasks for #{missing_tasks.join(", ")}" if missing_tasks.any?
errors << "#{assignments_path}: extra session-owner tasks for #{extra_tasks.join(", ")}" if extra_tasks.any?
errors << "#{assignments_path}: duplicate assigned agent ids: #{duplicate_agent_ids.join(", ")}" if duplicate_agent_ids.any?

group_by_session = Array(inventory["session_groups"]).each_with_object({}) do |group, memo|
  session_id = group["session_id"].to_s
  memo[session_id] = group unless session_id.empty?
end

tasks.each do |task|
  label = task_label(task)
  group = group_by_session[label]
  task_prefix = "#{assignments_path}:#{label}"
  unless group
    errors << "#{task_prefix}: no matching inventory session_group"
    next
  end

  if task["assignment_status"].to_s != "assigned"
    errors << "#{task_prefix}: assignment_status must be assigned"
  end
  unless present?(task["agent_id"])
    errors << "#{task_prefix}: agent_id is required to prove subagent assignment"
  end
  unless present?(task["assigned_at"])
    errors << "#{task_prefix}: assigned_at is required"
  end
  unless iso8601?(task["assigned_at"])
    errors << "#{task_prefix}: assigned_at must be ISO8601"
  end
  if task["task_sha256"].to_s != canonical_task_sha(task)
    errors << "#{task_prefix}: task_sha256 must match immutable task fields"
  end
  prompt_path = task["prompt_path"].to_s
  prompt_file_path = resolve_repo_path(prompt_path, brain)
  prompt_sha = File.file?(prompt_file_path) ? Digest::SHA256.hexdigest(File.read(prompt_file_path)) : nil
  if prompt_sha.to_s.empty? || task["prompt_sha256"].to_s != prompt_sha
    errors << "#{task_prefix}: prompt_sha256 must match prompt file"
  end
  if task["assignment_event_sha256"].to_s != assignment_event_sha(task)
    errors << "#{task_prefix}: assignment_event_sha256 must match assignment fields"
  end

  expected_units = expected_units_for_group(group)
  task_units = Array(task["expected_review_units"]).map(&:to_s)
  if task_units != expected_units
    errors << "#{task_prefix}: expected_review_units must match inventory review units"
  end
  unit_hashes = Array(task["review_unit_manifest"]).each_with_object({}) do |unit, memo|
    next unless unit.is_a?(Hash)

    unit_id = unit["unit_id"].to_s
    sha = unit["segment_sha256"].to_s
    memo[unit_id] = sha unless unit_id.empty? || sha.empty?
  end

  source_paths = Array(group["drafts"]).map(&:to_s)
  if Array(task["source_paths"]).map(&:to_s).sort != source_paths.sort
    errors << "#{task_prefix}: source_paths must match inventory drafts"
  end
  source_snapshot_paths = Array(group["source_snapshots"]).map(&:to_s).reject(&:empty?)
  if resolved_paths(task["source_snapshot_paths"], brain).sort != resolved_paths(source_snapshot_paths, brain).sort
    errors << "#{task_prefix}: source_snapshot_paths must match inventory source snapshots"
  end

  report_path = task["report_path"].to_s
  report_file_path = resolve_repo_path(report_path, brain)
  if report_path.empty? || !File.file?(report_file_path)
    errors << "#{task_prefix}: report_path is missing or not written"
    next
  end

  begin
    report = JSON.parse(File.read(report_file_path))
  rescue JSON::ParserError => error
    errors << "#{report_path}: invalid JSON: #{error.message}"
    next
  end

  if report["session_id"].to_s != label
    errors << "#{report_path}: session_id must match task"
  end
  if report["agent_id"].to_s != task["agent_id"].to_s
    errors << "#{report_path}: agent_id must match assignment"
  end
  if Array(report["source_paths"]).map(&:to_s).sort != source_paths.sort
    errors << "#{report_path}: source_paths must match task"
  end
  if resolved_paths(report["source_snapshot_paths"], brain).sort != resolved_paths(source_snapshot_paths, brain).sort
    errors << "#{report_path}: source_snapshot_paths must match task"
  end
  if Array(report["expected_review_units"]).map(&:to_s) != expected_units
    errors << "#{report_path}: expected_review_units must match task"
  end
  unless ALLOWED_DECISIONS.include?(report["draft_decision"].to_s)
    errors << "#{report_path}: draft_decision is invalid"
  end
  unless ALLOWED_MODES.include?(report["preservation_mode"].to_s)
    errors << "#{report_path}: preservation_mode is invalid"
  end
  unless iso8601?(report["written_at"])
    errors << "#{report_path}: written_at must be ISO8601"
  end
  coverage_notes = report["coverage_notes"].to_s.strip
  if coverage_notes.length < 20
    errors << "#{report_path}: coverage_notes must explain full-session coverage"
  end
  english_only!(errors, report_path, "coverage_notes", coverage_notes)

  units = Array(report["memory_units"])
  if units.empty?
    errors << "#{report_path}: memory_units must not be empty"
  end

  covered = Array(report["covered_review_units"])
  covered_ids = covered.map { |unit| unit.is_a?(Hash) ? unit["unit_id"].to_s : "" }.reject(&:empty?)
  duplicate_ids = covered_ids.select { |id| covered_ids.count(id) > 1 }.uniq
  missing_ids = expected_units - covered_ids
  extra_ids = covered_ids - expected_units
  errors << "#{report_path}: duplicate covered review units: #{duplicate_ids.join(", ")}" if duplicate_ids.any?
  errors << "#{report_path}: missing covered review units: #{missing_ids.join(", ")}" if missing_ids.any?
  errors << "#{report_path}: unexpected covered review units: #{extra_ids.join(", ")}" if extra_ids.any?

  units.each_with_index do |unit, index|
    unit_prefix = "#{report_path}:memory_units[#{index}]"
    unless unit.is_a?(Hash)
      errors << "#{unit_prefix}: must be an object"
      next
    end
    %w[summary source_anchor preservation_mode reason].each do |key|
      errors << "#{unit_prefix}: #{key} is required" unless present?(unit[key])
    end
    english_only!(errors, unit_prefix, "summary", unit["summary"])
    english_only!(errors, unit_prefix, "source_anchor", unit["source_anchor"])
    english_only!(errors, unit_prefix, "reason", unit["reason"])
    unless ALLOWED_UNIT_KINDS.include?(unit["kind"].to_s)
      errors << "#{unit_prefix}: kind is invalid"
    end
    unless ALLOWED_MODES.include?(unit["preservation_mode"].to_s)
      errors << "#{unit_prefix}: preservation_mode is invalid"
    end
    unless expected_units.any? { |unit_id| unit["source_anchor"].to_s.include?(unit_id) }
      errors << "#{unit_prefix}: source_anchor must include an expected review unit id"
    end
  end

  covered.each_with_index do |item, index|
    item_prefix = "#{report_path}:covered_review_units[#{index}]"
    unless item.is_a?(Hash)
      errors << "#{item_prefix}: must be an object"
      next
    end
    unit_id = item["unit_id"].to_s
    unless expected_units.include?(unit_id)
      errors << "#{item_prefix}: unit_id must be one of #{expected_units.join(", ")}"
    end
    unless ALLOWED_UNIT_STATUSES.include?(item["status"].to_s)
      errors << "#{item_prefix}: status is invalid"
    end
    expected_hash = unit_hashes[unit_id]
    if expected_hash && item["source_sha256"].to_s != expected_hash
      errors << "#{item_prefix}: source_sha256 must match review_unit_manifest"
    end
    summary = item["summary"].to_s.strip
    if summary.length < 20
      errors << "#{item_prefix}: summary must describe reviewed content or discard reason"
    end
    english_only!(errors, item_prefix, "summary", summary)
    indexes = item["memory_unit_indexes"]
    unless indexes.is_a?(Array) && indexes.any? && indexes.all? { |value| value.is_a?(Integer) }
      errors << "#{item_prefix}: memory_unit_indexes must reference memory_units"
      next
    end
    indexes.each do |unit_index|
      unit = units[unit_index]
      unless unit.is_a?(Hash)
        errors << "#{item_prefix}: memory_unit_indexes[#{unit_index}] does not reference a memory unit"
        next
      end
      unless unit["source_anchor"].to_s.include?(unit_id)
        errors << "#{item_prefix}: memory_units[#{unit_index}].source_anchor must include #{unit_id}"
      end
    end
  end
end

if errors.any?
  warn errors.join("\n")
  abort "session-owner report validation failed"
end

puts JSON.generate({
  ok: true,
  session: session,
  session_owner_tasks: tasks.length,
  reports: tasks.map { |task| task["report_path"] }
})
