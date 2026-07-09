#!/usr/bin/env ruby
# Regression tests for sanitized Dreams session-owner audit export.

require "digest"
require "fileutils"
require "json"
require "tmpdir"

EXPORT = File.expand_path("export-session-audit.rb", __dir__)

def write_json(path, object)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, JSON.pretty_generate(object) + "\n")
end

def assert(condition, message)
  abort message unless condition
end

Dir.mktmpdir("dreams-session-audit-test") do |root|
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test-session")
  report_rel = ".dreams/test-session/session-owner/reports/session-a.json"
  report_path = File.join(brain, report_rel)
  source_snapshot = File.join(session, "sources", "source-a.md")
  FileUtils.mkdir_p(File.join(session, "session-owner", "reports"))
  FileUtils.mkdir_p(File.join(brain, "inbox"))

  write_json(File.join(session, "inventory.json"), {
    "drafts" => [
      {
        "relative_path" => "inbox/auto/a.md",
        "sha256" => "a" * 64,
        "source_snapshot" => source_snapshot
      }
    ]
  })

  report = {
    "session_id" => "session-a",
    "agent_id" => "agent-a",
    "source_paths" => ["inbox/auto/a.md"],
    "source_snapshot_paths" => [source_snapshot],
    "expected_review_units" => ["draft-1"],
    "covered_review_units" => [
      {
        "unit_id" => "draft-1",
        "status" => "reviewed",
        "source_sha256" => "a" * 64,
        "summary" => "Reviewed durable source unit.",
        "memory_unit_indexes" => [0]
      }
    ],
    "memory_units" => [
      {
        "kind" => "decision",
        "summary" => "Future Dreams runs preserve audited session-owner report evidence.",
        "source_anchor" => "draft-1: audit export decision",
        "preservation_mode" => "synthesize",
        "reason" => "Durable auditability rule."
      }
    ],
    "draft_decision" => "promoted",
    "preservation_mode" => "synthesize",
    "target_recommendations" => ["decisions/example.md"],
    "coverage_notes" => "All expected review units reconciled.",
    "written_at" => "2026-06-07T10:00:00+07:00"
  }
  write_json(report_path, report)
  report_sha = Digest::SHA256.hexdigest(File.read(report_path))

  write_json(File.join(session, "session-owner", "assignments.json"), {
    "session" => session,
    "inventory" => File.join(session, "inventory.json"),
    "tasks" => [
      {
        "session_id" => "session-a",
        "agent_id" => "agent-a",
        "assignment_status" => "assigned",
        "assigned_at" => "2026-06-07T10:00:01+07:00",
        "source_paths" => ["inbox/auto/a.md"],
        "source_snapshot_paths" => [source_snapshot],
        "expected_review_units" => ["draft-1"],
        "report_path" => report_rel
      }
    ]
  })

  ledger_row = {
    "session" => ".dreams/test-session",
    "source_path" => "inbox/auto/a.md",
    "sha256" => "a" * 64,
    "archived_path" => "archive/inbox-reviewed/2026-06/a.md",
    "decision" => "promoted",
    "preservation_mode" => "synthesize",
    "targets" => ["decisions/example.md"],
    "session_owner_report" => {
      "session_id" => "session-a",
      "agent_id" => "agent-a",
      "report_path" => report_rel,
      "report_sha256" => report_sha,
      "covered_review_units" => ["draft-1"]
    },
    "memory_units" => report["memory_units"]
  }
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), JSON.generate(ledger_row) + "\n")

  output = IO.popen(["ruby", EXPORT, "--brain", brain, "--session", session], &:read)
  abort "export failed: #{output}" unless $?.success?
  result = JSON.parse(output)
  audit_path = File.join(brain, result.fetch("output"))
  audit_text = File.read(audit_path)
  audit = JSON.parse(audit_text)

  assert(audit["schema"] == "dreams-session-owner-audit.v1", "schema missing")
  assert(audit["session"] == ".dreams/test-session", "session must be repo-relative")
  assert(audit["session_owner_task_count"] == 1, "task count wrong")
  assert(audit["ledger_row_count"] == 1, "ledger count wrong")
  assert(audit["tasks"][0]["report_sha256"] == report_sha, "report sha missing")
  assert(audit["tasks"][0]["source_snapshot_paths"] == [".dreams/test-session/sources/source-a.md"], "source snapshot path not sanitized")
  assert(audit["tasks"][0]["ledger_binding"]["archived_path"] == "archive/inbox-reviewed/2026-06/a.md", "ledger binding missing")
  assert(!audit_text.include?(root), "audit must not contain temp absolute paths")
  assert(!audit_text.include?("/Users/"), "audit must not contain /Users absolute paths")
end

puts "export-session-audit regression tests passed"
