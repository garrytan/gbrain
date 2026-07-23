#!/usr/bin/env ruby
# Regression tests for dreams terminal session-state validation.

require "fileutils"
require "digest"
require "json"
require "time"
require "tmpdir"

require_relative "review_session_counts"

VALIDATOR = File.expand_path("validate-session-state.rb", __dir__)

def write_json(path, value)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, JSON.pretty_generate(value) + "\n")
end

def zero_count_map(keys)
  keys.to_h { |key| [key, 0] }
end

def default_counts(total)
  {
    "inventory_total" => total,
    "handled_total" => total,
    "by_decision" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_DECISIONS).merge("promoted" => total),
    "by_preservation_mode" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_MODES).merge("preserve-full" => total),
    "score_bands" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_SCORE_BANDS).merge("11+" => total)
  }
end

def default_post_inventory_audit
  counts = {
    "current_session_blocked_safety" => 0,
    "previous_blocked_safety" => 0,
    "new_pending_after_inventory" => 0,
    "unledgered_not_in_inventory" => 0,
    "ledgered_nonblocked_left_in_inbox" => 0,
    "inventory_unhandled_left_in_inbox" => 0,
    "dry_run_inventory_left_in_inbox" => 0
  }
  {
    "inventory_generated_at" => "2026-05-27T13:00:00+07:00",
    "checked_at" => "2026-05-27T14:00:00+07:00",
    "counts" => counts,
    "paths" => counts.keys.to_h { |key| [key, []] }
  }
end

def post_inventory_audit_section(audit = default_post_inventory_audit)
  <<~MD
    ## Post-Inventory Inbox Audit

    ```json
    #{JSON.pretty_generate(audit["counts"])}
    ```

    - Current-session blocked-safety drafts left in inbox: none
    - Previous blocked-safety drafts left in inbox: none
    - New pending drafts captured after inventory: none
    - Unledgered pre-existing drafts not in inventory: none
    - Ledgered nonblocked drafts still in inbox: none
    - Inventory drafts without session ledger rows still in inbox: none
    - Dry-run inventory drafts intentionally left in inbox: none
  MD
end

def summary_for_counts(counts)
  canonical = {
    "inventory_total" => counts["inventory_total"],
    "handled_total" => counts["handled_total"],
    "by_decision" => counts["by_decision"],
    "by_preservation_mode" => counts["by_preservation_mode"],
    "score_bands" => counts["score_bands"]
  }

  <<~MD
    # Dreams Summary

    ## Counts

    ```json
    #{JSON.pretty_generate(canonical)}
    ```

    #{post_inventory_audit_section}

    ## Proposal Audit

    - Target namespace READMEs read: none
    - Curated targets with proposed final-content artifacts: 0/0
    - Curated edits without proposal artifact: none

    ## Verification

    ## Quality Audit Sample

    Unresolved blockers: none.
  MD
end

template_counts = JSON.parse(File.read(File.expand_path("../templates/session-counts.json", __dir__)))
abort "session-counts template drifted from validator buckets" unless template_counts == default_counts(0)

def write_valid_session(root, overrides = {})
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  FileUtils.mkdir_p(File.join(brain, "inbox"))
  FileUtils.mkdir_p(File.join(session, "reports"))

  mode = {
    "dry_run" => false,
    "apply" => true,
    "sync" => true,
    "commit" => true,
    "push" => true
  }.merge(overrides.fetch(:mode, {}))

  inventory_total = overrides.fetch(:inventory_total, 1)
  counts = default_counts(inventory_total).merge(overrides.fetch(:counts, {}))

  state = {
    "active" => false,
    "phase" => "done",
    "completed_at" => "2026-05-27T14:00:00+07:00",
    "mode" => mode,
    "counts" => counts,
    "post_inventory_inbox_audit" => default_post_inventory_audit
  }.merge(overrides.fetch(:state, {}))

  write_json(File.join(session, "state.json"), state)
  write_json(File.join(session, "inventory.json"), {
    "generated_at" => "2026-05-27T13:00:00+07:00",
    "total" => inventory_total,
    "drafts" => Array.new(inventory_total) { |index| { "relative_path" => "inbox/#{index}.md" } }
  }.merge(overrides.fetch(:inventory_extra, {})))

  summary = overrides.fetch(:summary, summary_for_counts(counts))
  File.write(File.join(session, "reports", "SUMMARY.md"), summary)

  ledger = mode["dry_run"] ? File.join(session, "proposals", "review-ledger.jsonl") : File.join(brain, "inbox", "review-ledger.jsonl")
  FileUtils.mkdir_p(File.dirname(ledger))
  row_session = overrides.fetch(:row_session, session)
  ledger_row_count = overrides.fetch(:ledger_row_count, inventory_total)
  rows = Array.new(ledger_row_count) do |index|
    JSON.generate({
      "session" => row_session,
      "source_path" => "inbox/#{index}.md",
      "decision" => "promoted",
      "preservation_mode" => "preserve-full",
      "importance_score" => {
        "future_retrieval" => 3,
        "durability" => 3,
        "specificity" => 2,
        "authorship" => 2,
        "fidelity" => 1,
        "total" => 11
      }
    }.merge(overrides.fetch(:ledger_row, {})))
  end
  File.write(ledger, rows.join("\n") + "\n")

  [brain, session]
end

def assert_accepts(label, overrides = {})
  Dir.mktmpdir("review-state-ok") do |root|
    brain, session = write_valid_session(root, overrides)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
    abort "#{label}: validator rejected valid session" unless ok
  end
end

def assert_rejects(label, overrides = {})
  Dir.mktmpdir("review-state-bad") do |root|
    brain, session = write_valid_session(root, overrides)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
    abort "#{label}: validator accepted invalid session" if ok
  end
end

assert_accepts("valid apply session")
assert_accepts("valid relative session rows", row_session: ".dreams/test")
assert_accepts("valid empty session", inventory_total: 0)

assert_accepts(
  "valid dry-run session",
  mode: {
    "dry_run" => true,
    "apply" => false,
    "sync" => false,
    "commit" => false,
    "push" => false
  }
)

assert_rejects("active session", state: { "active" => true })
assert_rejects("bad completed_at", state: { "completed_at" => "not-a-date" })
assert_rejects("missing mode flag", mode: { "push" => nil })
assert_rejects("count mismatch", counts: { "handled_total" => 0 })
assert_rejects("partial count map", counts: { "by_decision" => { "promoted" => 1 } })
assert_rejects("ledger row count mismatch", inventory_total: 2, ledger_row_count: 1)
assert_rejects("ledger decision count mismatch", ledger_row: { "decision" => "discarded" })
assert_rejects("ledger mode count mismatch", ledger_row: { "preservation_mode" => "discard" })
assert_rejects("ledger score band mismatch", ledger_row: { "importance_score" => { "total" => 3 } })
assert_rejects("ledger invalid score shape", ledger_row: { "importance_score" => "bad-score" })
assert_rejects(
  "session-owner reports required for session groups",
  ledger_row: { "decision" => "discarded", "preservation_mode" => "discard" },
  counts: default_counts(1).merge(
    "by_decision" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_DECISIONS).merge("discarded" => 1),
    "by_preservation_mode" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_MODES).merge("discard" => 1),
    "score_bands" => zero_count_map(ReviewDraftsSessionCounts::ALLOWED_SCORE_BANDS).merge("0-3" => 1)
  ),
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
assert_rejects(
  "summary count mismatch",
  summary: summary_for_counts(default_counts(1).merge("handled_total" => 0))
)
assert_rejects(
  "missing summary count json",
  summary: "# Dreams Summary\n\n## Counts\n\n## Verification\n\n## Quality Audit Sample\n\nUnresolved blockers: none.\n"
)
assert_rejects("missing quality audit", summary: "# Dreams Summary\n\n## Counts\n\n```json\n{}\n```\n\n## Proposal Audit\n\n- Target namespace READMEs read: none\n- Curated targets with proposed final-content artifacts: 0/0\n- Curated edits without proposal artifact: none\n\n## Verification\n\nUnresolved blockers: none.\n")
assert_rejects("missing proposal audit", summary: "# Dreams Summary\n\n## Counts\n\n```json\n{}\n```\n\n## Verification\n\n## Quality Audit Sample\n\nUnresolved blockers: none.\n")
assert_rejects("missing post-inventory inbox audit", summary: summary_for_counts(default_counts(1)).sub(/## Post-Inventory Inbox Audit.*?(?=\n## Proposal Audit)/m, ""))
assert_rejects("missing post-inventory state audit", state: { "post_inventory_inbox_audit" => nil })
assert_rejects(
  "incomplete proposal audit",
  summary: summary_for_counts(default_counts(1)).sub("Curated edits without proposal artifact: none\n", "")
)
assert_rejects(
  "stale proposal audit coverage",
  summary: summary_for_counts(default_counts(1)).sub("Curated targets with proposed final-content artifacts: 0/0", "Curated targets with proposed final-content artifacts: 1/1")
)
assert_rejects(
  "stale proposal audit readmes",
  summary: summary_for_counts(default_counts(1)).sub("Target namespace READMEs read: none", "Target namespace READMEs read: projects/README.md")
)

Dir.mktmpdir("review-state-leftover") do |root|
  brain, session = write_valid_session(root)
  leftover = File.join(brain, "inbox", "0.md")
  File.write(leftover, "---\ncreated_at: 2026-05-27T12:00:00+07:00\n---\nHandled draft should have been archived.\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "nonblocked applied draft left in inbox: validator accepted invalid session" if ok
end

Dir.mktmpdir("review-state-post-check") do |root|
  original = "Original reviewed source snapshot\n"
  original_sha = Digest::SHA256.hexdigest(original)
  brain, session = write_valid_session(
    root,
    inventory_extra: {
      "drafts" => [{
        "relative_path" => "inbox/0.md",
        "dedupe_key" => original_sha[0, 16],
        "sha256" => original_sha
      }]
    }
  )
  late = File.join(brain, "inbox", "auto", "2026-05-27", "after-check.md")
  FileUtils.mkdir_p(File.dirname(late))
  File.write(late, "---\ncreated_at: 2026-05-27T14:30:00+07:00\n---\nDraft captured after this session was finalized.\n")
  old_created_late = File.join(brain, "inbox", "auto", "2026-05-27", "after-check-old-created.md")
  File.write(old_created_late, "---\ncreated_at: 2026-05-27T12:00:00+07:00\n---\nDraft written after this session was finalized despite old source time.\n")
  after_check_time = Time.parse("2026-05-27T14:30:00+07:00")
  File.utime(after_check_time, after_check_time, old_created_late)
  same_path = File.join(brain, "inbox", "0.md")
  File.write(same_path, "---\ncreated_at: 2026-05-27T12:00:00+07:00\n---\nSame path was rewritten after this session was finalized.\n")
  File.utime(after_check_time, after_check_time, same_path)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "post-check draft: validator rejected a valid completed session" unless ok
end

puts "validate-session-state regression tests passed"
