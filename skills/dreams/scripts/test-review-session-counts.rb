#!/usr/bin/env ruby
# Regression tests for shared dreams session count contract.

require "json"

require_relative "review_session_counts"

template = JSON.parse(File.read(File.expand_path("../templates/session-counts.json", __dir__)))

expected_zero = {
  "inventory_total" => 0,
  "handled_total" => 0,
  "by_decision" => ReviewDraftsSessionCounts.zero_count_map(ReviewDraftsSessionCounts::ALLOWED_DECISIONS),
  "by_preservation_mode" => ReviewDraftsSessionCounts.zero_count_map(ReviewDraftsSessionCounts::ALLOWED_MODES),
  "score_bands" => ReviewDraftsSessionCounts.zero_count_map(ReviewDraftsSessionCounts::ALLOWED_SCORE_BANDS)
}
abort "session-counts template drifted from shared contract" unless template == expected_zero

rows = [
  [42, {
    "decision" => "promoted",
    "preservation_mode" => "preserve-full",
    "importance_score" => { "total" => 13 }
  }],
  {
    "decision" => "discarded",
    "preservation_mode" => "discard",
    "importance_score" => { "total" => 2 }
  }
]

counts, errors = ReviewDraftsSessionCounts.final_counts(2, rows)
abort "valid rows produced errors: #{errors.join("; ")}" unless errors.empty?
abort "handled_total mismatch" unless counts["handled_total"] == 2
abort "decision aggregate mismatch" unless counts["by_decision"]["promoted"] == 1 && counts["by_decision"]["discarded"] == 1
abort "mode aggregate mismatch" unless counts["by_preservation_mode"]["preserve-full"] == 1 && counts["by_preservation_mode"]["discard"] == 1
abort "score aggregate mismatch" unless counts["score_bands"]["11+"] == 1 && counts["score_bands"]["0-3"] == 1

_bad_counts, bad_errors = ReviewDraftsSessionCounts.final_counts(2, [rows.first])
abort "missing row count was not detected" unless bad_errors.any? { |error| error.include?("does not equal inventory.total") }

_bad_counts, bad_errors = ReviewDraftsSessionCounts.final_counts(1, ["not-a-row"])
abort "non-object row was not detected" unless bad_errors.any? { |error| error.include?("not an object") }

puts "review-session-counts regression tests passed"
