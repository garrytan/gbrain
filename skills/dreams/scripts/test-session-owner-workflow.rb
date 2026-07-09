#!/usr/bin/env ruby
# Regression tests for Dreams session-owner task and report gates.

require "fileutils"
require "json"
require "tmpdir"

PREPARE = File.expand_path("prepare-session-owner-tasks.rb", __dir__)
RECORD = File.expand_path("record-session-owner-assignment.rb", __dir__)
VALIDATE = File.expand_path("validate-session-owner-reports.rb", __dir__)

def run_cmd(*args, out: File::NULL, err: File::NULL)
  system(*args, out: out, err: err)
end

def assert_cmd(label, *args)
  abort "#{label}: command failed: #{args.join(" ")}" unless run_cmd(*args)
end

def refute_cmd(label, *args)
  abort "#{label}: command unexpectedly passed: #{args.join(" ")}" if run_cmd(*args)
end

def write_json(path, object)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, JSON.pretty_generate(object) + "\n")
end

def repo_path(brain, path)
  path.to_s.start_with?(File::SEPARATOR) ? path : File.join(brain, path)
end

def report(session_id, agent_id, units, source_paths, unit_hashes = {}, source_snapshot_paths = [])
  {
    "session_id" => session_id,
    "agent_id" => agent_id,
    "source_paths" => source_paths,
    "source_snapshot_paths" => source_snapshot_paths,
    "expected_review_units" => units,
    "covered_review_units" => units.each_with_index.map do |unit_id, index|
      {
        "unit_id" => unit_id,
        "status" => "reviewed",
        "source_sha256" => unit_hashes[unit_id],
        "summary" => "Reviewed #{unit_id} for durable decisions and discardable status noise",
        "memory_unit_indexes" => [index]
      }
    end,
    "memory_units" => units.map do |unit_id|
      {
        "kind" => "other-ephemeral",
        "summary" => "No durable memory was found in #{unit_id} during session-owner review",
        "source_anchor" => "#{unit_id}: reviewed session source unit",
        "preservation_mode" => "discard",
        "reason" => "The reviewed unit contained temporary workflow context only"
      }
    end,
    "draft_decision" => "discarded",
    "preservation_mode" => "discard",
    "target_recommendations" => [],
    "coverage_notes" => "All expected session review units were reconciled by the session owner",
    "written_at" => "2026-06-07T17:00:00+07:00"
  }
end

Dir.mktmpdir("dreams-session-owner-test") do |root|
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  inventory_path = File.join(session, "inventory.json")
  FileUtils.mkdir_p(session)

  inventory = {
    "total" => 3,
    "session_groups" => [
      {
        "session_key" => "session-a",
        "session_id" => "session-a",
        "draft_count" => 1,
        "drafts" => ["inbox/auto/a.md"],
        "source_snapshots" => [File.join(session, "sources", "a.md")],
        "repo_names" => ["example-repo"],
        "capture_segment_count" => 2,
        "segment_manifest" => [
          { "segment_id" => "segment-1", "source_path" => "inbox/auto/a.md", "sha256" => "a" * 64, "source_anchor" => "segment-1 capture section" },
          { "segment_id" => "segment-2", "source_path" => "inbox/auto/a.md", "sha256" => "b" * 64, "source_anchor" => "segment-2 capture section" }
        ],
        "segment_parse_errors" => []
      },
      {
        "session_key" => "session-b",
        "session_id" => "session-b",
        "draft_count" => 1,
        "drafts" => ["inbox/auto/b.md"],
        "repo_names" => ["vuz_claude"],
        "capture_segment_count" => nil,
        "segment_manifest" => [],
        "segment_parse_errors" => []
      },
      {
        "session_key" => "session-c",
        "session_id" => "session-c",
        "draft_count" => 2,
        "drafts" => ["inbox/auto/c1.md", "inbox/auto/c2.md"],
        "repo_names" => ["legacy"],
        "capture_segment_count" => 2,
        "segment_manifest" => [
          { "segment_id" => "segment-1", "source_path" => "inbox/auto/c1.md", "sha256" => "c" * 64, "source_anchor" => "segment-1 first legacy draft" },
          { "segment_id" => "segment-1", "source_path" => "inbox/auto/c2.md", "sha256" => "d" * 64, "source_anchor" => "segment-1 second legacy draft" }
        ],
        "segment_parse_errors" => []
      },
      {
        "session_key" => "draft:manual",
        "session_id" => nil,
        "draft_count" => 1,
        "drafts" => ["inbox/manual.md"],
        "repo_names" => [],
        "segment_manifest" => [],
        "segment_parse_errors" => []
      }
    ],
    "drafts" => []
  }
  write_json(inventory_path, inventory)

  assert_cmd("prepare session owner tasks", "ruby", PREPARE, "--session", session, "--inventory", inventory_path)

  owner_root = File.join(session, "session-owner")
  assignments_path = File.join(owner_root, "assignments.json")
  assignments = JSON.parse(File.read(assignments_path))
  tasks = assignments.fetch("tasks")
  abort "expected one task per session_id group" unless tasks.map { |task| task["session_id"] }.sort == %w[session-a session-b session-c]
  abort "manual no-session draft should not receive a session-owner task" if tasks.any? { |task| task["session_id"].to_s.empty? }
  tasks.each do |task|
    abort "task json missing for #{task["session_id"]}" unless File.file?(task.fetch("task_path"))
    abort "task prompt missing for #{task["session_id"]}" unless File.file?(task.fetch("prompt_path"))
    abort "task report path should be repo-relative for #{task["session_id"]}" if task.fetch("report_path").start_with?(brain)
    abort "task report path missing for #{task["session_id"]}" unless task.fetch("report_path").end_with?(".json")
  end
  task_a = tasks.find { |task| task["session_id"] == "session-a" }
  task_b = tasks.find { |task| task["session_id"] == "session-b" }
  task_c = tasks.find { |task| task["session_id"] == "session-c" }
  abort "segment review units missing" unless task_a["expected_review_units"] == %w[segment-1 segment-2]
  abort "single draft review unit missing" unless task_b["expected_review_units"] == ["draft-1"]
  abort "duplicate segment ids were not qualified by draft" unless task_c["expected_review_units"] == ["draft-1:segment-1", "draft-2:segment-1"]
  abort "source snapshot paths missing from task" unless task_a["source_snapshot_paths"] == [File.join(session, "sources", "a.md")]
  prompt_a = File.read(task_a.fetch("prompt_path"))
  abort "prompt does not carry raw-boundary contract" unless prompt_a.include?("never promote from raw")
  abort "prompt does not name output path" unless prompt_a.include?(task_a.fetch("report_path"))
  abort "prompt does not name absolute report file path" unless prompt_a.include?(File.join(brain, task_a.fetch("report_path")))
  abort "prompt does not explain repo-relative report path resolution" unless prompt_a.include?("resolve it from `brain_root`")

  refute_cmd("pending assignments must not validate", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)

  assert_cmd(
    "record first assignment",
    "ruby", RECORD,
    "--session", session,
    "--session-id", "session-a",
    "--agent-id", "agent-a"
  )
  refute_cmd("missing second assignment must not validate", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)

  assert_cmd(
    "record second assignment",
    "ruby", RECORD,
    "--session", session,
    "--session-id", "session-b",
    "--agent-id", "agent-b"
  )
  assert_cmd(
    "record third assignment",
    "ruby", RECORD,
    "--session", session,
    "--session-id", "session-c",
    "--agent-id", "agent-c"
  )
  refute_cmd("assigned sessions without reports must not validate", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)

  incomplete = report("session-a", "agent-a", ["segment-1"], ["inbox/auto/a.md"], {}, task_a["source_snapshot_paths"])
  write_json(repo_path(brain, task_a.fetch("report_path")), incomplete)
  write_json(repo_path(brain, task_b.fetch("report_path")), report("session-b", "agent-b", ["draft-1"], ["inbox/auto/b.md"]))
  write_json(repo_path(brain, task_c.fetch("report_path")), report(
    "session-c",
    "agent-c",
    ["draft-1:segment-1", "draft-2:segment-1"],
    ["inbox/auto/c1.md", "inbox/auto/c2.md"],
    { "draft-1:segment-1" => "c" * 64, "draft-2:segment-1" => "d" * 64 }
  ))
  refute_cmd("incomplete segment report must not validate", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)

  write_json(repo_path(brain, task_a.fetch("report_path")), report(
    "session-a",
    "agent-a",
    %w[segment-1 segment-2],
    ["inbox/auto/a.md"],
    { "segment-1" => "a" * 64, "segment-2" => "b" * 64 },
    task_a["source_snapshot_paths"]
  ))
  assert_cmd("complete reports validate", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)

  assert_cmd("repo-relative report paths validate outside brain cwd", "ruby", VALIDATE, "--session", session, "--inventory", inventory_path)
end

puts "session-owner workflow regression tests passed"
