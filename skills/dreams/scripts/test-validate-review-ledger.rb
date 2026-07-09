#!/usr/bin/env ruby
# Regression tests for dreams ledger quality validation.

require "fileutils"
require "digest"
require "json"
require "tmpdir"

VALIDATOR = File.expand_path("validate-review-ledger.rb", __dir__)

SCORE = {
  future_retrieval: 3,
  durability: 3,
  specificity: 2,
  authorship: 3,
  fidelity: 2,
  total: 13
}.freeze

LOW_SCORE = {
  future_retrieval: 1,
  durability: 1,
  specificity: 1,
  authorship: 0,
  fidelity: 0,
  total: 3
}.freeze

SOURCE_SCORE = {
  future_retrieval: 2,
  durability: 1,
  specificity: 2,
  authorship: 0,
  fidelity: 0,
  total: 5
}.freeze

SYNTH_SCORE = {
  future_retrieval: 2,
  durability: 2,
  specificity: 3,
  authorship: 0,
  fidelity: 0,
  total: 7
}.freeze

UNIT = {
  kind: "authored-thinking",
  summary: "operator-authored strategy about preserving exact reasoning in memory",
  source_anchor: "source paragraph: preserving exact reasoning in memory",
  importance_score: SCORE,
  preservation_mode: "preserve-full",
  reason: "Future agents need the original reasoning, not a generic recap",
  anti_summary_reason: "The exact rationale controls whether agents preserve or flatten the note",
  target: "originals/memory-quality.md"
}.freeze

COVERAGE = {
  source_read: "source-snapshot",
  durable_content: "All durable authored memory units are represented in memory_units and target actions",
  discarded_content: "none",
  unsupported_additions: "none",
  loss_risk: "low"
}.freeze

SESSION_COVERAGE = {
  session_id: "session-abc",
  capture_segment_count: 2,
  segments: [
    {
      "segment_id" => "segment-1",
      "source_anchor" => "segment-1 baseline transcript section",
      "status" => "reviewed",
      "summary" => "Baseline transcript segment was reviewed for durable memory units",
      "memory_unit_indexes" => [0]
    },
    {
      "segment_id" => "segment-2",
      "source_anchor" => "segment-2 incremental transcript section",
      "status" => "reviewed",
      "summary" => "Incremental transcript segment was reviewed for durable memory units",
      "memory_unit_indexes" => [1]
    }
  ],
  review_strategy: "Reviewed the full aggregated session draft segment by segment before writing memory units"
}.freeze

NOISE_UNIT = {
  kind: "status-noise",
  summary: "Temporary progress chatter that has no durable memory value",
  source_anchor: "status update paragraph",
  importance_score: LOW_SCORE,
  preservation_mode: "discard",
  reason: "Momentary status chatter is represented for audit but not preserved"
}.freeze

def setup_case(root, row, inventory_drafts, row_session: nil)
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  FileUtils.mkdir_p(File.join(brain, "inbox"))
  FileUtils.mkdir_p(session)
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), JSON.generate(row.merge(session: row_session || session)) + "\n")
  File.write(File.join(session, "inventory.json"), JSON.pretty_generate({ "total" => inventory_drafts.length, "drafts" => inventory_drafts }) + "\n")
  [brain, session]
end

def setup_empty_case(root, inventory, write_ledger: true)
  brain = File.join(root, "brain")
  session = File.join(brain, ".dreams", "test")
  FileUtils.mkdir_p(File.join(brain, "inbox"))
  FileUtils.mkdir_p(session)
  File.write(File.join(session, "inventory.json"), JSON.pretty_generate(inventory) + "\n")
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), "") if write_ledger
  [brain, session]
end

def assert_validator_accepts(label, row, inventory_drafts, extra_args = [], row_session: nil)
  Dir.mktmpdir("brain-ledger-ok") do |root|
    brain, session = setup_case(root, row, inventory_drafts, row_session: row_session)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, *extra_args, out: File::NULL, err: File::NULL)
    abort "#{label}: validator rejected valid ledger" unless ok
  end
end

def assert_validator_rejects(label, row, inventory_drafts, extra_args = [], row_session: nil)
  Dir.mktmpdir("brain-ledger-bad") do |root|
    brain, session = setup_case(root, row, inventory_drafts, row_session: row_session)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, *extra_args, out: File::NULL, err: File::NULL)
    abort "#{label}: validator accepted invalid ledger" if ok
  end
end

def assert_evidence_validator_accepts(label, row, inventory_drafts)
  Dir.mktmpdir("brain-ledger-evidence-ok") do |root|
    brain, session = setup_case(root, row, inventory_drafts)
    if row[:archived_path] || row["archived_path"]
      archive = File.join(brain, row[:archived_path] || row["archived_path"])
      FileUtils.mkdir_p(File.dirname(archive))
      File.write(archive, "Archived source evidence body\n")
    end
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-evidence-drilldown", out: File::NULL, err: File::NULL)
    abort "#{label}: validator rejected valid evidence drilldown ledger" unless ok
  end
end

def assert_evidence_validator_rejects(label, row, inventory_drafts, write_archive: true)
  Dir.mktmpdir("brain-ledger-evidence-bad") do |root|
    brain, session = setup_case(root, row, inventory_drafts)
    if write_archive && (row[:archived_path] || row["archived_path"])
      archive = File.join(brain, row[:archived_path] || row["archived_path"])
      FileUtils.mkdir_p(File.dirname(archive))
      File.write(archive, "Archived source evidence body\n")
    end
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-evidence-drilldown", out: File::NULL, err: File::NULL)
    abort "#{label}: validator accepted invalid evidence drilldown ledger" if ok
  end
end

def assert_empty_validator_accepts(label, inventory, write_ledger: true)
  Dir.mktmpdir("brain-ledger-empty-ok") do |root|
    brain, session = setup_empty_case(root, inventory, write_ledger: write_ledger)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
    abort "#{label}: validator rejected empty session" unless ok
  end
end

def assert_empty_validator_rejects(label, inventory, write_ledger: true)
  Dir.mktmpdir("brain-ledger-empty-bad") do |root|
    brain, session = setup_empty_case(root, inventory, write_ledger: write_ledger)
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
    abort "#{label}: validator accepted invalid empty session" if ok
  end
end

def with_session_owner_binding_case(row, inventory_drafts)
  Dir.mktmpdir("brain-ledger-session-owner") do |root|
    brain, session = setup_case(root, row, inventory_drafts)
    owner_root = File.join(session, "session-owner")
    report_path = File.join(owner_root, "reports", "session-abc.json")
    FileUtils.mkdir_p(File.dirname(report_path))
    report = {
      "session_id" => "session-abc",
      "agent_id" => "agent-session-abc",
      "source_paths" => ["inbox/auto/session.md"],
      "expected_review_units" => ["segment-1", "segment-2"],
      "covered_review_units" => [
        { "unit_id" => "segment-1", "status" => "reviewed", "summary" => "Reviewed segment-1 for durable memory units", "memory_unit_indexes" => [0] },
        { "unit_id" => "segment-2", "status" => "reviewed", "summary" => "Reviewed segment-2 for durable memory units", "memory_unit_indexes" => [1] }
      ],
      "memory_units" => [
        { "source_anchor" => "segment-1: initial memory-quality decision" },
        { "source_anchor" => "segment-2: follow-up memory-quality decision" }
      ],
      "draft_decision" => "promoted",
      "preservation_mode" => "preserve-full",
      "coverage_notes" => "All expected review units were reconciled",
      "written_at" => "2026-06-07T17:00:00+07:00"
    }
    File.write(report_path, JSON.pretty_generate(report) + "\n")
    report_sha = Digest::SHA256.hexdigest(File.read(report_path))
    assignments = {
      "tasks" => [{
        "session_id" => "session-abc",
        "agent_id" => "agent-session-abc",
        "assignment_status" => "assigned",
        "assigned_at" => "2026-06-07T17:00:00+07:00",
        "source_paths" => ["inbox/auto/session.md"],
        "expected_review_units" => ["segment-1", "segment-2"],
        "report_path" => report_path
      }]
    }
    FileUtils.mkdir_p(owner_root)
    File.write(File.join(owner_root, "assignments.json"), JSON.pretty_generate(assignments) + "\n")
    yield brain, session, report_path, report_sha
  end
end

def page_text(current, timeline, indexed_at = "2026-05-26T12:05:00+07:00")
  <<~MARKDOWN
    ---
    type: original
    title: Memory Quality
    status: confirmed
    ---

    # Memory Quality

    ## Temporal Metadata

    - Effective date: 2026-05-26
    - Recorded at: 2026-05-26
    - Indexed at: #{indexed_at}

    ## Current Understanding

    #{current}

    ---

    ## Timeline

    #{timeline}
  MARKDOWN
end

def git!(brain, *args)
  ok = system("git", "-C", brain, *args, out: File::NULL, err: File::NULL)
  abort "git failed: #{args.join(" ")}" unless ok
end

def with_diff_case(row, inventory_drafts, old_text, current_text)
  Dir.mktmpdir("brain-ledger-diff") do |root|
    brain, session = setup_case(root, row, inventory_drafts)
    path = File.join(brain, "originals", "memory-quality.md")
    FileUtils.mkdir_p(File.dirname(path))
    git!(brain, "init")
    git!(brain, "config", "user.email", "test@example.invalid")
    git!(brain, "config", "user.name", "Dreams Test")
    if old_text
      File.write(path, old_text)
      git!(brain, "add", "originals/memory-quality.md")
      git!(brain, "commit", "-m", "seed")
    else
      git!(brain, "commit", "--allow-empty", "-m", "seed")
    end
    File.write(path, current_text)
    git!(brain, "add", "originals/memory-quality.md") if old_text.nil?
    yield brain, session
  end
end

def with_extra_changed_curated_file(row, inventory_drafts, old_text, current_text)
  with_diff_case(row, inventory_drafts, old_text, current_text) do |brain, session|
    extra = File.join(brain, "projects", "unaccounted.md")
    FileUtils.mkdir_p(File.dirname(extra))
    File.write(extra, page_text("Unaccounted compiled truth", "- new untracked evidence"))
    git!(brain, "add", "projects/unaccounted.md")
    yield brain, session
  end
end

def assert_diff_validator_accepts(label, row, inventory_drafts, old_text, current_text)
  with_diff_case(row, inventory_drafts, old_text, current_text) do |brain, session|
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
    abort "#{label}: validator rejected valid target diff" unless ok
  end
end

def assert_diff_validator_rejects(label, row, inventory_drafts, old_text, current_text)
  with_diff_case(row, inventory_drafts, old_text, current_text) do |brain, session|
    ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
    abort "#{label}: validator accepted invalid target diff" if ok
  end
end

def write_proposal_artifact(session, target, content = "proposed final curated markdown\n")
  path = File.join(session, "proposals", "curated", *target.split("/"))
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, content)
end

valid_row = {
  reviewed_at: "2026-05-27T14:00:00+07:00",
  source_path: "inbox/example.md",
  content_hash: "abc123",
  decision: "promoted",
  preservation_mode: "preserve-full",
  importance_score: SCORE,
  evidence_quality: "medium",
  quality_reason: "operator-authored strategy needs exact reasoning preserved",
  coverage: COVERAGE,
  targets: ["originals/memory-quality.md"],
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => true,
    "supporting_units" => [0],
    "reason" => "New evidence revises the compiled truth on this page"
  }],
  memory_units: [UNIT]
}

inventory = [{ "relative_path" => "inbox/example.md", "dedupe_key" => "abc123" }]
snapshot_source = "reviewed inventory snapshot\n"
snapshot_sha = Digest::SHA256.hexdigest(snapshot_source)
snapshot_inventory = [{
  "relative_path" => "inbox/example.md",
  "dedupe_key" => snapshot_sha[0, 16],
  "sha256" => snapshot_sha,
  "source_snapshot" => ".dreams/test/sources/#{snapshot_sha[0, 16]}-example.md"
}]
session_inventory = [{
  "relative_path" => "inbox/auto/session.md",
  "content_hash" => "frontmatter-old",
  "dedupe_key" => "session-session-abc-livehash",
  "sha256" => "live-sha256",
  "session_id" => "session-abc",
  "capture_mode" => "session",
  "capture_segment_count" => 2,
  "segment_numbers" => [1, 2],
  "segment_parse_errors" => [],
  "full_transcript_entry_count" => 42
}]
template_row = JSON.parse(File.read(File.expand_path("../templates/review-ledger-row.json", __dir__)))

assert_empty_validator_accepts(
  "empty ledger accepts empty inventory",
  { "total" => 0, "drafts" => [] }
)

assert_empty_validator_accepts(
  "missing ledger accepts empty inventory",
  { "total" => 0, "drafts" => [] },
  write_ledger: false
)

assert_empty_validator_rejects(
  "empty ledger rejects non-empty inventory",
  { "total" => 1, "drafts" => inventory }
)

assert_empty_validator_rejects(
  "missing ledger rejects non-empty inventory",
  { "total" => 1, "drafts" => inventory },
  write_ledger: false
)

assert_empty_validator_rejects(
  "empty ledger rejects inconsistent empty inventory total",
  { "total" => 1, "drafts" => [] }
)

assert_empty_validator_rejects(
  "empty ledger rejects missing inventory total",
  { "drafts" => [] }
)

assert_validator_accepts("valid preserve-full row", valid_row, inventory)
assert_validator_accepts("valid relative session row", valid_row, inventory, row_session: ".dreams/test")

session_row = valid_row.merge(
  source_path: "inbox/auto/session.md",
  content_hash: "frontmatter-old",
  dedupe_key: "session-session-abc-livehash",
  coverage: COVERAGE.merge(session_coverage: SESSION_COVERAGE),
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => true,
    "supporting_units" => [0, 1],
    "reason" => "New evidence revises the compiled truth on this page"
  }],
  memory_units: [
    UNIT.merge(
      summary: "Baseline segment preserves the initial memory-quality decision",
      source_anchor: "segment-1: initial memory-quality decision"
    ),
    UNIT.merge(
      summary: "Incremental segment preserves the follow-up memory-quality decision",
      source_anchor: "segment-2: follow-up memory-quality decision"
    )
  ]
)
assert_validator_accepts("multi-segment session row requires explicit segment coverage", session_row, session_inventory)

assert_validator_rejects(
  "multi-segment session row rejects stale content hash without live session identity",
  session_row.reject { |key, _value| key == :dedupe_key },
  session_inventory
)

assert_validator_rejects(
  "multi-segment session row rejects missing session coverage",
  session_row.merge(coverage: COVERAGE),
  session_inventory
)

assert_validator_rejects(
  "multi-segment session row rejects incomplete segment coverage",
  session_row.merge(coverage: COVERAGE.merge(session_coverage: SESSION_COVERAGE.merge(
    segments: [SESSION_COVERAGE.fetch(:segments).first]
  ))),
  session_inventory
)

assert_validator_rejects(
  "multi-segment session row rejects wrong session id",
  session_row.merge(coverage: COVERAGE.merge(session_coverage: SESSION_COVERAGE.merge(session_id: "other-session"))),
  session_inventory
)

assert_validator_rejects(
  "multi-segment session row rejects unanchored memory units",
  session_row.merge(memory_units: [UNIT]),
  session_inventory
)

with_session_owner_binding_case(session_row, session_inventory) do |brain, session, report_path, report_sha|
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "session owner binding: validator accepted missing session_owner_report" if ok

  bound_row = session_row.merge(
    session_owner_report: {
      "session_id" => "session-abc",
      "agent_id" => "agent-session-abc",
      "report_path" => report_path,
      "report_sha256" => report_sha,
      "covered_review_units" => ["segment-1", "segment-2"]
    }
  )
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), JSON.generate(bound_row.merge(session: session)) + "\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "session owner binding: validator rejected valid session_owner_report binding" unless ok

  bad_row = bound_row.merge(session_owner_report: bound_row[:session_owner_report].merge("report_sha256" => "wrong"))
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), JSON.generate(bad_row.merge(session: session)) + "\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "session owner binding: validator accepted wrong report hash" if ok

  rel_report_path = report_path.delete_prefix("#{brain}/")
  assignments_path = File.join(session, "session-owner", "assignments.json")
  assignments = JSON.parse(File.read(assignments_path))
  assignments["tasks"][0]["report_path"] = rel_report_path
  File.write(assignments_path, JSON.pretty_generate(assignments) + "\n")
  rel_bound_row = bound_row.merge(session_owner_report: bound_row[:session_owner_report].merge("report_path" => rel_report_path))
  File.write(File.join(brain, "inbox", "review-ledger.jsonl"), JSON.generate(rel_bound_row.merge(session: ".dreams/test")) + "\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "session owner binding: validator rejected repo-relative report_path" unless ok
end

evidence_row = valid_row.merge(
  archived_path: "archive/inbox-reviewed/2026-05/example.md",
  target_timeline_entry: {
    "target" => "originals/memory-quality.md",
    "source_hash" => "abc123",
    "summary" => "Reviewed draft evidence for this memory update"
  },
  source_excerpt_summary: "Bounded English summary of the archived source evidence for drilldown"
)

assert_evidence_validator_accepts("valid evidence drilldown row", evidence_row, inventory)

Dir.mktmpdir("brain-ledger-evidence-manifest") do |root|
  brain, session = setup_case(
    root,
    evidence_row.merge(
      sha256: snapshot_sha,
      dedupe_key: snapshot_sha[0, 16],
      content_hash: nil,
      target_timeline_entry: evidence_row.fetch(:target_timeline_entry).merge("source_hash" => snapshot_sha)
    ),
    snapshot_inventory
  )
  archive = File.join(brain, "archive/inbox-reviewed/2026-05/example.md")
  FileUtils.mkdir_p(File.dirname(archive))
  File.write(archive, "mutated live source that was not the reviewed snapshot\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-evidence-drilldown", out: File::NULL, err: File::NULL)
  abort "evidence drilldown archive manifest: validator accepted archive without reviewed snapshot proof" if ok
end

assert_evidence_validator_rejects(
  "evidence drilldown requires archived_path",
  evidence_row.reject { |key, _value| key == :archived_path },
  inventory
)

assert_evidence_validator_rejects(
  "evidence drilldown requires archived file",
  evidence_row,
  inventory,
  write_archive: false
)

assert_evidence_validator_rejects(
  "evidence drilldown requires source excerpt summary",
  evidence_row.reject { |key, _value| key == :source_excerpt_summary },
  inventory
)

assert_evidence_validator_rejects(
  "evidence drilldown rejects placeholder source excerpt summary",
  evidence_row.merge(source_excerpt_summary: "source excerpt or heading"),
  inventory
)

assert_evidence_validator_rejects(
  "curated evidence drilldown requires target timeline entry",
  evidence_row.reject { |key, _value| key == :target_timeline_entry },
  inventory
)

assert_evidence_validator_rejects(
  "target timeline source hash must match row identity",
  evidence_row.merge(target_timeline_entry: {
    "target" => "originals/memory-quality.md",
    "source_hash" => "wronghash",
    "summary" => "Reviewed draft evidence for this memory update"
  }),
  inventory
)

assert_evidence_validator_rejects(
  "target timeline target must match row targets",
  evidence_row.merge(target_timeline_entry: {
    "target" => "decisions/other-memory.md",
    "source_hash" => "abc123",
    "summary" => "Reviewed draft evidence for this memory update"
  }),
  inventory
)

blocked_evidence_row = valid_row.merge(
  decision: "blocked-safety",
  preservation_mode: "blocked-safety",
  importance_score: LOW_SCORE,
  evidence_quality: "low",
  quality_reason: "Unsafe source material cannot be archived automatically",
  coverage: COVERAGE.merge(
    durable_content: "Unsafe source material was not represented in curated memory",
    discarded_content: "Unsafe source material remains blocked for manual review",
    loss_risk: "high"
  ),
  targets: [],
  target_actions: [],
  memory_units: [
    NOISE_UNIT.merge(
      kind: "unsafe",
      summary: "Unsafe private source material cannot be safely archived automatically",
      source_anchor: "unsafe source block",
      preservation_mode: "blocked-safety",
      reason: "Contains unsafe material that should remain unpromoted"
    )
  ]
)

assert_evidence_validator_accepts(
  "blocked-safety rows do not require evidence archive drilldown",
  blocked_evidence_row,
  inventory
)

parse_error_inventory = inventory.map do |draft|
  draft.merge("segment_parse_errors" => ["out-of-range capture segment headings: 14"])
end

assert_validator_accepts(
  "blocked-safety rows reconcile inventory segment parse errors",
  blocked_evidence_row,
  parse_error_inventory
)

assert_validator_rejects(
  "Russian quality reason is rejected",
  valid_row.merge(quality_reason: "Русский текст не должен попадать в ledger memory fields"),
  inventory
)

assert_validator_rejects(
  "Russian coverage durable content is rejected",
  valid_row.merge(coverage: COVERAGE.merge(durable_content: "Русский текст не должен попадать в durable content")),
  inventory
)

assert_validator_rejects(
  "Russian memory unit summary is rejected",
  valid_row.merge(memory_units: [UNIT.merge(summary: "Русский текст не должен попадать в memory unit summary")]),
  inventory
)

assert_validator_rejects(
  "Russian target action reason is rejected",
  valid_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => true,
    "supporting_units" => [0],
    "reason" => "Русский текст не должен попадать в target action reason"
  }]),
  inventory
)

assert_validator_rejects("template row placeholders", template_row, inventory)

assert_validator_rejects(
  "missing memory_units",
  valid_row.reject { |key, _value| key == :memory_units },
  inventory
)

assert_validator_rejects(
  "extra row score key",
  valid_row.merge(importance_score: SCORE.merge(extra_dimension: 0)),
  inventory
)

assert_validator_rejects(
  "extra unit score key",
  valid_row.merge(memory_units: [UNIT.merge(importance_score: SCORE.merge(extra_dimension: 0))]),
  inventory
)

assert_validator_rejects(
  "missing coverage assessment",
  valid_row.reject { |key, _value| key == :coverage },
  inventory
)

assert_validator_rejects(
  "unsupported additions are invalid",
  valid_row.merge(coverage: COVERAGE.merge(unsupported_additions: "Added inferred claims")),
  inventory
)

assert_validator_rejects(
  "high loss risk cannot finalize promoted row",
  valid_row.merge(coverage: COVERAGE.merge(loss_risk: "high")),
  inventory
)

assert_validator_rejects(
  "discarded coverage requires non-durable unit",
  valid_row.merge(coverage: COVERAGE.merge(discarded_content: "Only progress chatter was discarded")),
  inventory
)

assert_validator_rejects(
  "non-durable unit conflicts with discarded none",
  valid_row.merge(memory_units: [UNIT, NOISE_UNIT]),
  inventory
)

assert_validator_accepts(
  "discarded coverage with explicit noise unit",
  valid_row.merge(
    coverage: COVERAGE.merge(discarded_content: "Only progress chatter was discarded"),
    memory_units: [UNIT, NOISE_UNIT]
  ),
  inventory
)

assert_validator_rejects(
  "missing source path identity",
  valid_row.reject { |key, _value| key == :source_path },
  inventory
)

assert_validator_rejects(
  "missing source hash identity",
  valid_row.reject { |key, _value| key == :content_hash },
  inventory
)

assert_validator_rejects(
  "missing anti_summary_reason",
  valid_row.merge(memory_units: [UNIT.reject { |key, _value| key == :anti_summary_reason }]),
  inventory
)

assert_validator_rejects(
  "missing source anchor",
  valid_row.merge(memory_units: [UNIT.reject { |key, _value| key == :source_anchor }]),
  inventory
)

assert_validator_rejects(
  "placeholder source anchor",
  valid_row.merge(memory_units: [UNIT.merge(source_anchor: "Sanitized source phrase, heading, or local source-snapshot section")]),
  inventory
)

assert_validator_rejects(
  "placeholder unit summary",
  valid_row.merge(memory_units: [UNIT.merge(summary: "Specific authored claim or passage being evaluated")]),
  inventory
)

assert_validator_rejects(
  "placeholder coverage durable content",
  valid_row.merge(coverage: COVERAGE.merge(durable_content: "All durable source material is represented in memory_units and target_actions")),
  inventory
)

assert_validator_rejects(
  "duplicate hides preserve unit",
  valid_row.merge(decision: "duplicate", preservation_mode: "duplicate", targets: [], target_actions: [], memory_units: [UNIT]),
  inventory
)

assert_validator_rejects(
  "missing target_actions for promoted memory",
  valid_row.reject { |key, _value| key == :target_actions },
  inventory
)

assert_validator_rejects(
  "target action missing supporting units",
  valid_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => true,
    "reason" => "New evidence revises the compiled truth on this page"
  }]),
  inventory
)

assert_validator_rejects(
  "target action supporting unit must support target",
  valid_row.merge(
    target_actions: [{
      "path" => "originals/memory-quality.md",
      "action" => "update",
      "compiled_truth_changed" => true,
      "supporting_units" => [0],
      "reason" => "New evidence revises the compiled truth on this page"
    }],
    memory_units: [UNIT.merge(target: "decisions/other-memory.md")]
  ),
  inventory
)

assert_validator_rejects(
  "target action outside curated namespace",
  valid_row.merge(target_actions: [{
    "path" => "inbox/example.md",
    "action" => "update",
    "compiled_truth_changed" => true,
    "reason" => "New evidence revises the compiled truth on this page"
  }]),
  inventory
)

assert_validator_rejects(
  "target action missing reason",
  valid_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => true
  }]),
  inventory
)

assert_validator_rejects(
  "update without compiled truth flag",
  valid_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "update",
    "compiled_truth_changed" => false,
    "reason" => "New evidence revises the compiled truth on this page"
  }]),
  inventory
)

assert_validator_rejects(
  "target action missing one target",
  valid_row.merge(
    targets: ["originals/memory-quality.md", "decisions/memory-policy.md"],
    target_actions: [{
      "path" => "originals/memory-quality.md",
      "action" => "update",
      "compiled_truth_changed" => true,
      "reason" => "New evidence revises the compiled truth on this page"
    }]
  ),
  inventory
)

unsupported_target_unit = UNIT.reject { |key, _value| key == :target }.merge(
  kind: "source-evidence",
  importance_score: SOURCE_SCORE,
  preservation_mode: "source-note",
  reason: "This unit records provenance but does not support a curated target"
)

assert_validator_rejects(
  "target action requires supporting memory unit",
  valid_row.merge(memory_units: [unsupported_target_unit]),
  inventory
)

assert_validator_rejects(
  "duplicate row targets are invalid",
  valid_row.merge(targets: ["originals/memory-quality.md", "originals/memory-quality.md"]),
  inventory
)

assert_validator_rejects(
  "row target outside curated namespace",
  valid_row.merge(targets: ["inbox/example.md"]),
  inventory
)

assert_validator_rejects(
  "unhandled inventory draft",
  valid_row,
  inventory + [{ "relative_path" => "inbox/unhandled.md", "dedupe_key" => "def456" }]
)

Dir.mktmpdir("brain-ledger-extra-row") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  extra_row = valid_row.merge(source_path: "inbox/extra.md", content_hash: "extra456", memory_units: [UNIT])
  File.open(File.join(brain, "inbox", "review-ledger.jsonl"), "a") do |file|
    file.write(JSON.generate(extra_row.merge(session: session)) + "\n")
  end
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "extra ledger row: validator accepted row not present in inventory" if ok
end

Dir.mktmpdir("brain-ledger-bad-total") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  File.write(File.join(session, "inventory.json"), JSON.pretty_generate({ "total" => 2, "drafts" => inventory }) + "\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "bad inventory total: validator accepted inconsistent inventory" if ok
end

assert_validator_rejects(
  "hash-only row cannot reconcile inventory",
  valid_row.merge(source_path: "inbox/other.md"),
  inventory
)

assert_validator_rejects(
  "path match with wrong hash fails",
  valid_row.merge(content_hash: "wronghash"),
  inventory
)

duplicate_row_same_source = valid_row.merge(
  source_path: "inbox/example.md",
  content_hash: "abc123"
)
Dir.mktmpdir("brain-ledger-duplicate-source") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  File.open(File.join(brain, "inbox", "review-ledger.jsonl"), "a") do |file|
    file.write(JSON.generate(duplicate_row_same_source.merge(session: session)) + "\n")
  end
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, out: File::NULL, err: File::NULL)
  abort "duplicate source row: validator accepted invalid ledger" if ok
end

assert_validator_rejects(
  "high fidelity cannot be source-note",
  valid_row.merge(
    decision: "source-note",
    preservation_mode: "source-note",
    targets: [],
    target_actions: [],
    memory_units: [UNIT.merge(preservation_mode: "source-note")]
  ),
  inventory
)

assert_validator_rejects(
  "high fidelity cannot be synthesize",
  valid_row.merge(
    preservation_mode: "synthesize",
    target_actions: [{
      "path" => "originals/memory-quality.md",
      "action" => "append-timeline",
      "compiled_truth_changed" => false,
      "reason" => "New source only adds provenance for the existing truth"
    }],
    memory_units: [UNIT.merge(preservation_mode: "synthesize")]
  ),
  inventory
)

assert_validator_rejects(
  "preserve-full cannot have low score",
  valid_row.merge(
    importance_score: LOW_SCORE,
    memory_units: [UNIT.merge(importance_score: LOW_SCORE)]
  ),
  inventory
)

assert_validator_rejects(
  "discard cannot contain durable unit",
  valid_row.merge(
    decision: "discarded",
    preservation_mode: "discard",
    targets: [],
    target_actions: [],
    memory_units: [UNIT.merge(preservation_mode: "discard", kind: "decision", target: nil)]
  ),
  inventory
)

assert_validator_rejects(
  "unit target must be covered by row targets",
  valid_row.merge(memory_units: [UNIT.merge(target: "originals/other-memory.md")]),
  inventory
)

assert_validator_rejects(
  "unit target required when row has multiple targets",
  valid_row.merge(
    targets: ["originals/memory-quality.md", "decisions/memory-policy.md"],
    target_actions: [
      {
        "path" => "originals/memory-quality.md",
        "action" => "update",
        "compiled_truth_changed" => true,
        "reason" => "New evidence revises the compiled truth on this page"
      },
      {
        "path" => "decisions/memory-policy.md",
        "action" => "update",
        "compiled_truth_changed" => true,
        "reason" => "New evidence revises the compiled truth on this page"
      }
    ],
    memory_units: [UNIT.reject { |key, _value| key == :target }]
  ),
  inventory
)

assert_validator_rejects(
  "duplicate target action path",
  valid_row.merge(target_actions: [
    {
      "path" => "originals/memory-quality.md",
      "action" => "update",
      "compiled_truth_changed" => true,
      "reason" => "New evidence revises the compiled truth on this page"
    },
    {
      "path" => "originals/memory-quality.md",
      "action" => "append-timeline",
      "compiled_truth_changed" => false,
      "reason" => "New source only adds provenance for the existing truth"
    }
  ]),
  inventory
)

source_note_valid_unit = UNIT.reject { |key, _value| key == :target }.merge(
  kind: "source-evidence",
  importance_score: SOURCE_SCORE,
  preservation_mode: "source-note",
  reason: "This is useful provenance but does not change searchable memory"
)
source_note_valid_row = valid_row.merge(
  decision: "source-note",
  preservation_mode: "source-note",
  importance_score: SOURCE_SCORE,
  targets: [],
  target_actions: [],
  memory_units: [source_note_valid_unit]
)

assert_validator_accepts("source-note accepts medium provenance score", source_note_valid_row, inventory)

synth_unit = UNIT.merge(
  kind: "project-fact",
  importance_score: SYNTH_SCORE,
  preservation_mode: "synthesize",
  reason: "The stable project fact matters more than exact wording",
  anti_summary_reason: nil
)
synth_row = valid_row.merge(
  preservation_mode: "synthesize",
  importance_score: SYNTH_SCORE,
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "append-timeline",
    "compiled_truth_changed" => false,
    "supporting_units" => [0],
    "reason" => "New source only adds provenance for the existing truth"
  }],
  memory_units: [synth_unit]
)

assert_validator_accepts("synthesize accepts low-fidelity durable fact", synth_row, inventory)

duplicate_unit = UNIT.merge(
  kind: "duplicate",
  preservation_mode: "duplicate",
  reason: "The same durable memory is already preserved at equal fidelity"
)
duplicate_row = valid_row.merge(
  decision: "duplicate",
  preservation_mode: "duplicate",
  coverage: COVERAGE.merge(discarded_content: "The same durable claim is already preserved elsewhere"),
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "no-change-duplicate",
    "reason" => "Existing curated page already preserves this memory"
  }],
  memory_units: [duplicate_unit]
)

assert_validator_accepts("duplicate no-change target action", duplicate_row, inventory)

source_note_unit = UNIT.reject { |key, _value| key == :target }.merge(
  kind: "source-evidence",
  preservation_mode: "source-note",
  reason: "This is useful provenance but does not change searchable memory"
)
source_note_row = valid_row.merge(
  decision: "source-note",
  preservation_mode: "source-note",
  targets: [],
  memory_units: [source_note_unit]
)

assert_validator_rejects(
  "source-note cannot carry target_actions",
  source_note_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "append-timeline",
    "compiled_truth_changed" => false,
    "reason" => "This should not be present on a source-note row"
  }]),
  inventory
)

old_page = page_text("Old compiled truth", "- old evidence")
updated_page = page_text("New compiled truth", "- old evidence\n- new evidence")
timeline_only_page = page_text("Old compiled truth", "- old evidence\n- new evidence")
timeline_only_with_index_stamp = page_text("Old compiled truth", "- old evidence\n- new evidence", "2026-05-27T14:00:00+07:00")

Dir.mktmpdir("brain-ledger-empty-unaccounted") do |root|
  brain, session = setup_empty_case(root, { "total" => 0, "drafts" => [] }, write_ledger: false)
  path = File.join(brain, "projects", "unaccounted.md")
  FileUtils.mkdir_p(File.dirname(path))
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  File.write(path, old_page)
  git!(brain, "add", "projects/unaccounted.md")
  git!(brain, "commit", "-m", "seed")
  File.write(path, updated_page)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
  abort "empty inventory target diff: validator accepted unaccounted curated change" if ok
end

Dir.mktmpdir("brain-ledger-empty-untracked") do |root|
  brain, session = setup_empty_case(root, { "total" => 0, "drafts" => [] }, write_ledger: false)
  path = File.join(brain, "projects", "untracked.md")
  FileUtils.mkdir_p(File.dirname(path))
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  git!(brain, "commit", "--allow-empty", "-m", "seed")
  File.write(path, updated_page)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
  abort "empty inventory target diff: validator accepted untracked curated file" if ok
end

assert_diff_validator_accepts(
  "update changes compiled truth",
  valid_row,
  inventory,
  old_page,
  updated_page
)

assert_diff_validator_rejects(
  "update without compiled truth diff",
  valid_row,
  inventory,
  old_page,
  timeline_only_page
)

append_row = valid_row.merge(
  preservation_mode: "synthesize",
  importance_score: SYNTH_SCORE,
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "append-timeline",
    "compiled_truth_changed" => false,
    "supporting_units" => [0],
    "reason" => "New source only adds provenance for the existing truth"
  }],
  memory_units: [synth_unit]
)

create_row = valid_row.merge(
  target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "create",
    "compiled_truth_changed" => true,
    "supporting_units" => [0],
    "reason" => "New curated page preserves this durable authored memory"
  }]
)

Dir.mktmpdir("brain-ledger-untracked-create") do |root|
  brain, session = setup_case(root, create_row, inventory)
  path = File.join(brain, "originals", "memory-quality.md")
  FileUtils.mkdir_p(File.dirname(path))
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  git!(brain, "commit", "--allow-empty", "-m", "seed")
  File.write(path, updated_page)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
  abort "untracked create target: validator accepted unstaged curated file" if ok
end

assert_diff_validator_accepts(
  "append timeline leaves compiled truth",
  append_row,
  inventory,
  old_page,
  timeline_only_page
)

assert_diff_validator_rejects(
  "append timeline changes compiled truth",
  append_row,
  inventory,
  old_page,
  updated_page
)

assert_diff_validator_accepts(
  "create staged new target",
  create_row,
  inventory,
  nil,
  updated_page
)

assert_diff_validator_rejects(
  "create rejects existing target",
  create_row,
  inventory,
  old_page,
  updated_page
)

assert_diff_validator_accepts(
  "append timeline ignores temporal metadata stamp",
  append_row,
  inventory,
  old_page,
  timeline_only_with_index_stamp
)

assert_validator_rejects(
  "preserve-full cannot be timeline-only",
  valid_row.merge(target_actions: [{
    "path" => "originals/memory-quality.md",
    "action" => "append-timeline",
    "compiled_truth_changed" => false,
    "reason" => "New source only adds provenance for the existing truth"
  }]),
  inventory
)

Dir.mktmpdir("brain-ledger-proposal-ok") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  write_proposal_artifact(session, "originals/memory-quality.md")
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-proposal-artifacts", out: File::NULL, err: File::NULL)
  abort "proposal artifact gate rejected valid proposal mirror" unless ok
end

Dir.mktmpdir("brain-ledger-proposal-missing") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-proposal-artifacts", out: File::NULL, err: File::NULL)
  abort "proposal artifact gate accepted missing proposal mirror" if ok
end

Dir.mktmpdir("brain-ledger-proposal-current-match") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  content = page_text("Proposed compiled truth", "- proposed evidence")
  target = File.join(brain, "originals", "memory-quality.md")
  FileUtils.mkdir_p(File.dirname(target))
  File.write(target, content)
  write_proposal_artifact(session, "originals/memory-quality.md", content)
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-proposal-current-match", out: File::NULL, err: File::NULL)
  abort "proposal current-match gate rejected matching applied page" unless ok
end

Dir.mktmpdir("brain-ledger-proposal-current-mismatch") do |root|
  brain, session = setup_case(root, valid_row, inventory)
  target = File.join(brain, "originals", "memory-quality.md")
  FileUtils.mkdir_p(File.dirname(target))
  File.write(target, page_text("Different applied truth", "- applied evidence"))
  write_proposal_artifact(session, "originals/memory-quality.md", page_text("Proposed compiled truth", "- proposed evidence"))
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-proposal-current-match", out: File::NULL, err: File::NULL)
  abort "proposal current-match gate accepted mismatched applied page" if ok
end

with_extra_changed_curated_file(valid_row, inventory, old_page, updated_page) do |brain, session|
  ok = system("ruby", VALIDATOR, "--brain", brain, "--session", session, "--require-target-diff", out: File::NULL, err: File::NULL)
  abort "unaccounted curated target: validator accepted invalid target diff" if ok
end

puts "validate-review-ledger regression tests passed"
