#!/usr/bin/env ruby
# Regression tests for archiving reviewed Dreams sources from frozen snapshots.

require "digest"
require "fileutils"
require "json"
require "tmpdir"

HELPER = File.expand_path("archive-reviewed-sources.rb", __dir__)
VALIDATOR = File.expand_path("validate-review-ledger.rb", __dir__)

def score(total)
  {
    "future_retrieval" => 1,
    "durability" => 1,
    "specificity" => 0,
    "authorship" => 0,
    "fidelity" => [total - 2, 0].max,
    "total" => total
  }
end

def discard_row(session, index, sha)
  {
    "reviewed_at" => "2026-06-16T10:00:00+07:00",
    "session" => session,
    "source_path" => "inbox/#{index}.md",
    "dedupe_key" => sha[0, 16],
    "sha256" => sha,
    "archived_path" => "archive/inbox-reviewed/2026-06/#{index}.md",
    "decision" => "discarded",
    "preservation_mode" => "discard",
    "importance_score" => score(2),
    "evidence_quality" => "medium",
    "quality_reason" => "Reviewed source was temporary status material",
    "coverage" => {
      "source_read" => "source-snapshot",
      "durable_content" => "No durable source material needed curated preservation",
      "discarded_content" => "Temporary status material was intentionally discarded",
      "unsupported_additions" => "none",
      "loss_risk" => "low"
    },
    "targets" => [],
    "target_actions" => [],
    "source_excerpt_summary" => "Archived source evidence records the reviewed discarded status material",
    "memory_units" => [{
      "kind" => "status-noise",
      "summary" => "Temporary status material with no durable memory value",
      "source_anchor" => "source paragraph: temporary status material",
      "importance_score" => score(2),
      "preservation_mode" => "discard",
      "reason" => "Short-lived progress status does not need durable retrieval"
    }]
  }
end

Dir.mktmpdir("dreams-archive-reviewed") do |root|
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  sources = File.join(session, "sources")
  inbox = File.join(brain, "inbox")
  FileUtils.mkdir_p(sources)
  FileUtils.mkdir_p(inbox)

  original_a = "---\ncreated_at: 2026-06-16T09:00:00+07:00\n---\nOriginal reviewed source A\n"
  original_b = "---\ncreated_at: 2026-06-16T09:05:00+07:00\n---\nOriginal reviewed source B\n"
  sha_a = Digest::SHA256.hexdigest(original_a)
  sha_b = Digest::SHA256.hexdigest(original_b)
  snapshot_a = File.join(sources, "#{sha_a[0, 16]}-0.md")
  snapshot_b = File.join(sources, "#{sha_b[0, 16]}-1.md")
  File.write(snapshot_a, original_a)
  File.write(snapshot_b, original_b)
  File.write(File.join(inbox, "0.md"), original_a)
  File.write(File.join(inbox, "1.md"), "---\ncreated_at: 2026-06-16T09:05:00+07:00\n---\nChanged same-path source B\n")

  inventory = {
    "generated_at" => "2026-06-16T09:10:00+07:00",
    "total" => 2,
    "drafts" => [
      {
        "relative_path" => "inbox/0.md",
        "dedupe_key" => sha_a[0, 16],
        "sha256" => sha_a,
        "source_snapshot" => snapshot_a
      },
      {
        "relative_path" => "inbox/1.md",
        "dedupe_key" => sha_b[0, 16],
        "sha256" => sha_b,
        "source_snapshot" => snapshot_b
      }
    ]
  }
  File.write(File.join(session, "inventory.json"), JSON.pretty_generate(inventory) + "\n")
  rows = [discard_row(session, 0, sha_a), discard_row(session, 1, sha_b)]
  File.write(File.join(inbox, "review-ledger.jsonl"), rows.map { |row| JSON.generate(row) }.join("\n") + "\n")

  ok = system("ruby", HELPER, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "archive-reviewed-sources failed" unless ok

  archive_a = File.join(brain, "archive/inbox-reviewed/2026-06/0.md")
  archive_b = File.join(brain, "archive/inbox-reviewed/2026-06/1.md")
  abort "unchanged archive did not use source snapshot" unless File.read(archive_a) == original_a
  abort "changed archive did not use source snapshot" unless File.read(archive_b) == original_b
  abort "unchanged live source was not removed" if File.exist?(File.join(inbox, "0.md"))
  abort "changed same-path live source should stay pending" unless File.exist?(File.join(inbox, "1.md"))
  abort "changed same-path live source was overwritten" unless File.read(File.join(inbox, "1.md")).include?("Changed same-path source B")

  manifest_path = File.join(brain, "archive/dreams-session-audits/test/archive-manifest.json")
  manifest = JSON.parse(File.read(manifest_path))
  abort "manifest schema wrong" unless manifest["schema"] == "dreams-archive-manifest.v1"
  abort "manifest entry count wrong" unless manifest.fetch("entries").length == 2
  entry_b = manifest.fetch("entries").find { |entry| entry["source_path"] == "inbox/1.md" }
  abort "manifest missing changed source status" unless entry_b && entry_b["live_source_status"] == "left_changed_pending"
  abort "manifest does not prove reviewed snapshot" unless entry_b["archived_pre_redaction_sha256"] == sha_b

  valid = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-evidence-drilldown", out: File::NULL, err: File::NULL)
  abort "validator rejected archived sources with manifest proof" unless valid

  File.write(archive_b, "[REDACTED]\n")
  rerun = system("ruby", HELPER, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "archive-reviewed-sources rerun failed after redaction" unless rerun
  abort "archive helper overwrote existing redacted archive on rerun" unless File.read(archive_b) == "[REDACTED]\n"
end

puts "archive-reviewed-sources regression tests passed"
