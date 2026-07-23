#!/usr/bin/env ruby
# Create one auditable session-owner task per stop-hook session group.

require "fileutils"
require "json"
require "optparse"
require "time"

options = {
  session: nil,
  inventory: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: prepare-session-owner-tasks.rb --session PATH --inventory PATH"
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--inventory PATH", "Inventory JSON path") { |value| options[:inventory] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

session = File.expand_path(options[:session])
inventory_path = File.expand_path(options[:inventory] || File.join(session, "inventory.json"))
abort "inventory not found: #{inventory_path}" unless File.file?(inventory_path)

brain = if session.include?("#{File::SEPARATOR}.dreams#{File::SEPARATOR}")
          session.split("#{File::SEPARATOR}.dreams#{File::SEPARATOR}", 2).first
        else
          File.dirname(File.dirname(session))
        end
relative_session = session.delete_prefix("#{brain}#{File::SEPARATOR}")

def safe_key(value)
  key = value.to_s.strip.gsub(/[^A-Za-z0-9._-]+/, "-")
  key.empty? ? "unknown" : key
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

def repo_path(brain, path)
  value = path.to_s
  return value if value.start_with?(File::SEPARATOR)

  File.join(brain, value)
end

def task_prompt(task, brain)
  prompt_task = {
    "brain_root" => brain,
    "session_id" => task["session_id"],
    "source_paths" => task["source_paths"],
    "source_snapshot_paths" => task["source_snapshot_paths"],
    "expected_review_units" => task["expected_review_units"],
    "review_unit_manifest" => task["review_unit_manifest"],
    "segment_parse_errors" => task["segment_parse_errors"],
    "report_path" => task["report_path"],
    "report_file_path" => repo_path(brain, task["report_path"])
  }

  <<~PROMPT
    You are the Dreams session owner for one stop-hook session.

    Objective: review this whole session as one conversation context and write the required JSON report.

    Source boundary:
    - read only reviewed redacted inbox/source snapshot paths listed in this task;
    - never promote from raw ~/.gbrain/inbox/**;
    - never index inbox/archive/raw material;
    - report durable memory candidates in English only.

    Task metadata:
    ```json
    #{JSON.pretty_generate(prompt_task)}
    ```

    Write the JSON report to `report_file_path` in task metadata. `report_path` is repo-relative for audit/redaction metadata; if you need to resolve it yourself, resolve it from `brain_root`.
    Agent id: the Lead will send your assigned agent_id immediately after spawning you. Use that exact value in the report.

    Required JSON report shape:
    {
      "session_id": "#{task["session_id"]}",
      "agent_id": "<assigned agent id>",
      "source_paths": #{JSON.generate(task["source_paths"])},
      "source_snapshot_paths": #{JSON.generate(task["source_snapshot_paths"])},
      "expected_review_units": #{JSON.generate(task["expected_review_units"])},
      "covered_review_units": [
        {
          "unit_id": "<one expected unit id>",
          "status": "reviewed|discarded|duplicate|unsafe|blocked",
          "source_sha256": "<segment/source hash from review_unit_manifest when present>",
          "summary": "English summary of what this unit contributes or why it was discarded",
          "memory_unit_indexes": [0]
        }
      ],
      "memory_units": [
        {
          "kind": "decision|project-fact|gotcha|status-noise|other-ephemeral|other-durable",
          "summary": "English source-specific claim or discard note",
          "source_anchor": "<expected unit id>: short sanitized source pointer",
          "preservation_mode": "preserve-full|preserve-substantial|synthesize|source-note|discard|duplicate|blocked-safety",
          "reason": "English reason"
        }
      ],
      "draft_decision": "promoted|low-confidence-promoted|source-note|discarded|duplicate|blocked-safety",
      "preservation_mode": "preserve-full|preserve-substantial|synthesize|source-note|discard|duplicate|blocked-safety",
      "target_recommendations": [],
      "coverage_notes": "All expected review units reconciled; no unit skipped.",
      "written_at": "<ISO8601>"
    }
  PROMPT
end

inventory = JSON.parse(File.read(inventory_path))
owner_root = File.join(session, "session-owner")
tasks_dir = File.join(owner_root, "tasks")
prompts_dir = File.join(owner_root, "prompts")
reports_dir = File.join(owner_root, "reports")
FileUtils.mkdir_p(tasks_dir)
FileUtils.mkdir_p(prompts_dir)
FileUtils.mkdir_p(reports_dir)

tasks = Array(inventory["session_groups"]).map do |group|
  session_id = group["session_id"].to_s.strip
  next if session_id.empty?

  key = safe_key(session_id)
  task_path = File.join(tasks_dir, "#{key}.json")
  prompt_path = File.join(prompts_dir, "#{key}.md")
  report_path = File.join(relative_session, "session-owner", "reports", "#{key}.json")
  review_unit_manifest = review_unit_records(group)
  task = {
    "session_id" => session_id,
    "session_key" => group["session_key"],
    "repo_names" => Array(group["repo_names"]).map(&:to_s).reject(&:empty?),
    "source_paths" => Array(group["drafts"]).map(&:to_s),
    "source_snapshot_paths" => Array(group["source_snapshots"]).map(&:to_s).reject(&:empty?),
    "expected_review_units" => review_unit_manifest.map { |unit| unit["unit_id"] },
    "review_unit_manifest" => review_unit_manifest,
    "segment_manifest" => Array(group["segment_manifest"]),
    "segment_parse_errors" => Array(group["segment_parse_errors"]).map(&:to_s).reject(&:empty?),
    "task_path" => task_path,
    "prompt_path" => prompt_path,
    "report_path" => report_path,
    "assignment_status" => "pending_assignment",
    "agent_id" => nil,
    "assigned_at" => nil,
    "created_at" => Time.now.iso8601
  }
  File.write(task_path, JSON.pretty_generate(task) + "\n")
  File.write(prompt_path, task_prompt(task, brain))
  task
end.compact

manifest = {
  "generated_at" => Time.now.iso8601,
  "session" => session,
  "inventory" => inventory_path,
  "total_session_owner_tasks" => tasks.length,
  "tasks" => tasks
}
File.write(File.join(owner_root, "assignments.json"), JSON.pretty_generate(manifest) + "\n")

puts JSON.generate({
  ok: true,
  session: session,
  assignments: File.join(owner_root, "assignments.json"),
  total_session_owner_tasks: tasks.length
})
