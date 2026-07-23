#!/usr/bin/env ruby
# Regression tests for deterministic dreams session finalization.

require "fileutils"
require "digest"
require "json"
require "time"
require "tmpdir"

FINALIZER = File.expand_path("finalize-session-state.rb", __dir__)
VALIDATOR = File.expand_path("validate-session-state.rb", __dir__)

def write_json(path, value)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, JSON.pretty_generate(value) + "\n")
end

def score(total)
  case total
  when 0..3
    {
      "future_retrieval" => 1,
      "durability" => 1,
      "specificity" => 0,
      "authorship" => 0,
      "fidelity" => total - 2
    }
  when 4..6
    {
      "future_retrieval" => 2,
      "durability" => 1,
      "specificity" => 2,
      "authorship" => 0,
      "fidelity" => total - 5
    }
  when 7..10
    {
      "future_retrieval" => 2,
      "durability" => 2,
      "specificity" => 3,
      "authorship" => 0,
      "fidelity" => total - 7
    }
  else
    {
      "future_retrieval" => 3,
      "durability" => 3,
      "specificity" => 3,
      "authorship" => 3,
      "fidelity" => total - 12
    }
  end.merge("total" => total)
end

def unit_for(index, kind, mode, total, target: nil)
  unit = {
    "kind" => kind,
    "summary" => "Specific durable review item #{index} with enough detail for validation",
    "source_anchor" => "source heading: finalizer-counts item #{index}",
    "importance_score" => score(total),
    "preservation_mode" => mode,
    "reason" => "Concrete review reason for item #{index} and its preservation mode"
  }
  unit["target"] = target if target
  unit["anti_summary_reason"] = "Exact reasoning would be lost for item #{index}" if total >= 11 || %w[preserve-full preserve-substantial].include?(mode)
  unit
end

def ledger_row(session, index, decision, mode, total)
  target = "originals/finalizer-counts-#{index}.md"
  discarded_content = %w[discard duplicate blocked-safety].include?(mode) ? "This unit is intentionally not promoted as durable memory" : "none"
  row = {
    "reviewed_at" => "2026-05-27T15:00:00+07:00",
    "session" => session,
    "source_path" => "inbox/#{index}.md",
    "content_hash" => "hash#{index}",
    "decision" => decision,
    "preservation_mode" => mode,
    "importance_score" => score(total),
    "evidence_quality" => "medium",
    "quality_reason" => "Concrete future retrieval reason for ledger item #{index}",
    "coverage" => {
      "source_read" => "source-snapshot",
      "durable_content" => "All durable source material for item #{index} is represented in memory units",
      "discarded_content" => discarded_content,
      "unsupported_additions" => "none",
      "loss_risk" => "low"
    }
  }
  case mode
  when "preserve-full"
    row.merge!(
      "targets" => [target],
      "target_actions" => [{
        "path" => target,
        "action" => "update",
        "compiled_truth_changed" => true,
        "supporting_units" => [0],
        "reason" => "New evidence changes the compiled truth for item #{index}"
      }],
      "memory_units" => [unit_for(index, "authored-thinking", mode, total, target: target)]
    )
  when "synthesize"
    row.merge!(
      "targets" => [target],
      "target_actions" => [{
        "path" => target,
        "action" => "append-timeline",
        "compiled_truth_changed" => false,
        "supporting_units" => [0],
        "reason" => "New source adds provenance for existing item #{index}"
      }],
      "memory_units" => [unit_for(index, "project-fact", mode, total, target: target)]
    )
  when "source-note"
    row.merge!(
      "targets" => [],
      "target_actions" => [],
      "memory_units" => [unit_for(index, "source-evidence", mode, total)]
    )
  when "discard"
    row.merge!(
      "targets" => [],
      "target_actions" => [],
      "memory_units" => [unit_for(index, "status-noise", mode, total)]
    )
  else
    row
  end
end

def curated_targets(rows)
  rows.flat_map do |row|
    Array(row["target_actions"]).map { |action| action["path"].to_s } + Array(row["targets"]).map(&:to_s)
  end.select { |path| path.start_with?("people/", "companies/", "projects/", "decisions/", "gotchas/", "concepts/", "meetings/", "originals/") && path.end_with?(".md") }.uniq
end

def setup_session(root, mode:, row_session: nil, rows: nil, inventory_total: nil, write_ledger: true, write_proposal_artifacts: true, inventory_extra: {})
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  FileUtils.mkdir_p(File.join(brain, "inbox"))
  FileUtils.mkdir_p(File.join(session, "reports"))

  row_session ||= session
  rows ||= [
    ledger_row(row_session, 0, "promoted", "preserve-full", 13),
    ledger_row(row_session, 1, "low-confidence-promoted", "synthesize", 7),
    ledger_row(row_session, 2, "source-note", "source-note", 5),
    ledger_row(row_session, 3, "discarded", "discard", 2)
  ]
  rows.each { |row| row["session"] ||= row_session }
  inventory_total = rows.length if inventory_total.nil?

  write_json(File.join(session, "state.json"), {
    "active" => true,
    "phase" => "apply",
    "mode" => mode,
    "counts" => {}
  })
  write_json(File.join(session, "inventory.json"), {
    "generated_at" => "2026-05-27T14:00:00+07:00",
    "total" => inventory_total,
    "drafts" => Array.new(inventory_total) { |index| { "relative_path" => "inbox/#{index}.md", "dedupe_key" => "hash#{index}" } }
  }.merge(inventory_extra))
  File.write(File.join(session, "reports", "SUMMARY.md"), <<~MD)
    # Dreams Summary

    ## Counts

    old hand-written counts

    ## Proposal Audit

    - Target namespace READMEs read: originals/README.md
    - Curated targets with proposed final-content artifacts: 1/1
    - Curated edits without proposal artifact: none

    ## Verification

    checked

    ## Quality Audit Sample

    sampled

    Unresolved blockers: none.
  MD

  ledger = mode["dry_run"] ? File.join(session, "proposals", "review-ledger.jsonl") : File.join(brain, "inbox", "review-ledger.jsonl")
  if write_ledger
    FileUtils.mkdir_p(File.dirname(ledger))
    File.write(ledger, rows.map { |row| JSON.generate(row) }.join("\n") + "\n")
  end

  if write_proposal_artifacts
    curated_targets(rows).each do |target|
      path = File.join(session, "proposals", "curated", target)
      FileUtils.mkdir_p(File.dirname(path))
      File.write(path, "# Proposal artifact for #{target}\n")
    end
  end

  [brain, session]
end

def run_finalizer(brain, session, extra_args = [])
  system("ruby", FINALIZER, "--brain", brain, "--session", session, "--timestamp", "2026-05-27T15:00:00+07:00", *extra_args, out: File::NULL, err: File::NULL)
end

def assert_finalizes(label, mode:, row_session: nil, rows: nil, inventory_total: nil, write_ledger: true, expected_counts: nil, inventory_extra: {})
  Dir.mktmpdir("review-finalize-ok") do |root|
    brain, session = setup_session(root, mode: mode, row_session: row_session, rows: rows, inventory_total: inventory_total, write_ledger: write_ledger, inventory_extra: inventory_extra)
    abort "#{label}: finalizer rejected valid session" unless run_finalizer(brain, session)
    abort "#{label}: validator rejected finalized session" unless system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)

    state = JSON.parse(File.read(File.join(session, "state.json")))
    summary = File.read(File.join(session, "reports", "SUMMARY.md"))
    expected_counts ||= {
      "inventory_total" => 4,
      "handled_total" => 4,
      "by_decision" => {
        "promoted" => 1,
        "low-confidence-promoted" => 1,
        "source-note" => 1,
        "discarded" => 1,
        "duplicate" => 0,
        "blocked-safety" => 0
      },
      "by_preservation_mode" => {
        "preserve-full" => 1,
        "preserve-substantial" => 0,
        "synthesize" => 1,
        "source-note" => 1,
        "discard" => 1,
        "duplicate" => 0,
        "blocked-safety" => 0
      },
      "score_bands" => {
        "0-3" => 1,
        "4-6" => 1,
        "7-10" => 1,
        "11+" => 1
      }
    }

    abort "#{label}: state not terminal" unless state["active"] == false && state["phase"] == "done"
    abort "#{label}: completed_at not stamped" unless state["completed_at"] == "2026-05-27T15:00:00+07:00"
    abort "#{label}: counts mismatch" unless state["counts"] == expected_counts
    abort "#{label}: summary kept stale counts" if summary.include?("old hand-written counts")
    abort "#{label}: summary missing count json" unless summary.include?(JSON.pretty_generate(expected_counts))
    abort "#{label}: state missing post-inventory inbox audit" unless state["post_inventory_inbox_audit"].is_a?(Hash)
    abort "#{label}: summary missing post-inventory inbox audit" unless summary.include?("## Post-Inventory Inbox Audit")
  end
end

def assert_finalizer_rejects(label, mode:, rows: nil, inventory_total: nil, inventory_extra: {}, write_proposal_artifacts: true)
  Dir.mktmpdir("review-finalize-bad") do |root|
    brain, session = setup_session(root, mode: mode, rows: rows, inventory_total: inventory_total, inventory_extra: inventory_extra, write_proposal_artifacts: write_proposal_artifacts)
    abort "#{label}: finalizer accepted invalid session" if run_finalizer(brain, session)
  end
end

apply_mode = {
  "dry_run" => false,
  "apply" => true,
  "sync" => true,
  "commit" => true,
  "push" => true
}
dry_mode = {
  "dry_run" => true,
  "apply" => false,
  "sync" => false,
  "commit" => false,
  "push" => false
}

assert_finalizes("apply session", mode: apply_mode)
assert_finalizes("relative session rows", mode: apply_mode, row_session: ".dreams/test")
assert_finalizes("dry-run session", mode: dry_mode)

Dir.mktmpdir("review-finalize-pending") do |root|
  brain, session = setup_session(root, mode: apply_mode)
  late_path = File.join(brain, "inbox", "auto", "2026-05-27", "late.md")
  FileUtils.mkdir_p(File.dirname(late_path))
  File.write(late_path, <<~MD)
    ---
    source: stop-memory-capture
    created_at: 2026-05-27T15:30:00+07:00
    session_id: late-session
    ---

    Late draft captured after the review inventory was created.
  MD
  old_created_late_path = File.join(brain, "inbox", "auto", "2026-05-27", "old-created-late-file.md")
  File.write(old_created_late_path, <<~MD)
    ---
    source: stop-memory-capture
    created_at: 2026-05-27T12:00:00+07:00
    session_id: old-created-late-session
    ---

    Draft file appeared after inventory even though its source timestamp is old.
  MD
  late_file_time = Time.parse("2026-05-27T14:30:00+07:00")
  File.utime(late_file_time, late_file_time, old_created_late_path)

  abort "post-inventory pending draft: finalizer rejected valid session" unless run_finalizer(brain, session)

  state = JSON.parse(File.read(File.join(session, "state.json")))
  audit = state.fetch("post_inventory_inbox_audit")
  summary = File.read(File.join(session, "reports", "SUMMARY.md"))
  new_paths = audit.fetch("paths").fetch("new_pending_after_inventory")
  abort "post-inventory pending draft: wrong pending count" unless audit.fetch("counts").fetch("new_pending_after_inventory") == 2
  abort "post-inventory pending draft: missing pending path" unless new_paths == ["inbox/auto/2026-05-27/late.md", "inbox/auto/2026-05-27/old-created-late-file.md"]
  abort "post-inventory pending draft: summary missing pending path" unless summary.include?("inbox/auto/2026-05-27/late.md")
  abort "post-inventory pending draft: summary missing old-created pending path" unless summary.include?("inbox/auto/2026-05-27/old-created-late-file.md")
end

Dir.mktmpdir("review-finalize-skip-targeted") do |root|
  skip_ledger = File.join(root, "skip-targeted-run.jsonl")
  brain, session = setup_session(root, mode: apply_mode, inventory_extra: { "ledger_path" => skip_ledger })
  skipped_path = File.join(brain, "inbox", "auto", "2026-05-27", "skipped.md")
  FileUtils.mkdir_p(File.dirname(skipped_path))
  skipped_content = <<~MD
    ---
    source: stop-memory-capture
    created_at: 2026-05-27T12:00:00+07:00
    session_id: skipped-session
    ---

    Draft excluded from a targeted run boundary.
  MD
  File.write(skipped_path, skipped_content)
  skipped_time = Time.parse("2026-05-27T12:30:00+07:00")
  File.utime(skipped_time, skipped_time, skipped_path)
  File.write(skip_ledger, JSON.generate({
    "source_path" => "inbox/auto/2026-05-27/skipped.md",
    "sha256" => Digest::SHA256.hexdigest(skipped_content),
    "dedupe_key" => "skipped-boundary",
    "decision" => "skip-targeted-run"
  }) + "\n")

  abort "skip-targeted pending draft: finalizer rejected valid session" unless run_finalizer(brain, session)
  abort "skip-targeted pending draft: validator rejected valid completed session" unless system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)

  audit = JSON.parse(File.read(File.join(session, "state.json"))).fetch("post_inventory_inbox_audit")
  new_paths = audit.fetch("paths").fetch("new_pending_after_inventory")
  abort "skip-targeted pending draft: wrong pending count" unless audit.fetch("counts").fetch("new_pending_after_inventory") == 1
  abort "skip-targeted pending draft: wrong pending path" unless new_paths == ["inbox/auto/2026-05-27/skipped.md"]
  abort "skip-targeted pending draft: should not be hard failure" unless audit.fetch("counts").fetch("unledgered_not_in_inventory") == 0
end

Dir.mktmpdir("review-finalize-same-path-pending") do |root|
  original = "Original inventoried source content\n"
  original_sha = Digest::SHA256.hexdigest(original)
  row = ledger_row(nil, 0, "discarded", "discard", 2).merge(
    "content_hash" => original_sha[0, 16],
    "dedupe_key" => original_sha[0, 16],
    "sha256" => original_sha
  )
  brain, session = setup_session(
    root,
    mode: apply_mode,
    rows: [row],
    inventory_total: 1,
    inventory_extra: {
      "drafts" => [{
        "relative_path" => "inbox/0.md",
        "dedupe_key" => original_sha[0, 16],
        "sha256" => original_sha
      }]
    }
  )
  changed_path = File.join(brain, "inbox", "0.md")
  File.write(changed_path, "---\ncreated_at: 2026-05-27T12:00:00+07:00\n---\nChanged content written after inventory.\n")
  changed_time = Time.parse("2026-05-27T14:30:00+07:00")
  File.utime(changed_time, changed_time, changed_path)

  abort "same-path pending draft: finalizer rejected valid session" unless run_finalizer(brain, session)
  abort "same-path pending draft: validator rejected valid completed session" unless system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)

  audit = JSON.parse(File.read(File.join(session, "state.json"))).fetch("post_inventory_inbox_audit")
  abort "same-path pending draft: wrong pending count" unless audit.fetch("counts").fetch("new_pending_after_inventory") == 1
  abort "same-path pending draft: wrong pending path" unless audit.fetch("paths").fetch("new_pending_after_inventory") == ["inbox/0.md"]
end

assert_finalizes(
  "empty session without ledger",
  mode: apply_mode,
  rows: [],
  inventory_total: 0,
  write_ledger: false,
  expected_counts: {
    "inventory_total" => 0,
    "handled_total" => 0,
    "by_decision" => {
      "promoted" => 0,
      "low-confidence-promoted" => 0,
      "source-note" => 0,
      "discarded" => 0,
      "duplicate" => 0,
      "blocked-safety" => 0
    },
    "by_preservation_mode" => {
      "preserve-full" => 0,
      "preserve-substantial" => 0,
      "synthesize" => 0,
      "source-note" => 0,
      "discard" => 0,
      "duplicate" => 0,
      "blocked-safety" => 0
    },
    "score_bands" => {
      "0-3" => 0,
      "4-6" => 0,
      "7-10" => 0,
      "11+" => 0
    }
  }
)
assert_finalizer_rejects("missing ledger row", mode: apply_mode, inventory_total: 5)
assert_finalizer_rejects("missing proposal artifact", mode: apply_mode, write_proposal_artifacts: false)
bad_identity_rows = [ledger_row(nil, 0, "promoted", "preserve-full", 13).tap { |row| row.delete("content_hash") }]
assert_finalizer_rejects("invalid ledger identity", mode: apply_mode, rows: bad_identity_rows)
assert_finalizer_rejects(
  "session-owner reports required for session groups",
  mode: apply_mode,
  rows: [ledger_row(nil, 0, "discarded", "discard", 2)],
  inventory_total: 1,
  inventory_extra: {
    "session_groups" => [{
      "session_id" => "session-a",
      "session_key" => "session-a",
      "draft_count" => 1,
      "drafts" => ["inbox/0.md"],
      "segment_manifest" => [],
      "segment_parse_errors" => []
    }]
  }
)
assert_finalizer_rejects(
  "invalid dry-run flags",
  mode: {
    "dry_run" => true,
    "apply" => true,
    "sync" => false,
    "commit" => false,
    "push" => false
  }
)

Dir.mktmpdir("review-finalize-mode") do |root|
  bad_mode = apply_mode.merge("push" => nil)
  brain, session = setup_session(root, mode: bad_mode)
  abort "missing mode flag: finalizer accepted invalid session" if run_finalizer(brain, session)
end

Dir.mktmpdir("review-finalize-timestamp") do |root|
  brain, session = setup_session(root, mode: apply_mode)
  ok = system("ruby", FINALIZER, "--brain", brain, "--session", session, "--timestamp", "not-a-date", out: File::NULL, err: File::NULL)
  abort "bad timestamp: finalizer accepted invalid timestamp" if ok
end

Dir.mktmpdir("review-finalize-invalid") do |root|
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  bad_rows = [ledger_row(session, 0, "bad-decision", "preserve-full", 13)]
  brain, session = setup_session(root, mode: apply_mode, rows: bad_rows)
  abort "invalid decision: finalizer accepted invalid session" if run_finalizer(brain, session)
end

puts "finalize-session-state regression tests passed"
