#!/usr/bin/env ruby
# Regression tests for dreams inventory frontmatter parsing and dedupe.

require "fileutils"
require "json"
require "tmpdir"

INVENTORY = File.expand_path("inventory.rb", __dir__)

Dir.mktmpdir("brain-inventory-test") do |root|
  brain = File.join(root, "brain")
  inbox = File.join(brain, "inbox")
  session = File.join(brain, ".dreams", "test")
  FileUtils.mkdir_p(inbox)

  File.write(File.join(inbox, "preserve.md"), <<~MD)
    ---
    type: draft
    source: codex
    created_at: 2026-05-27T13:00:00+07:00
    memory_intent: preserve-full
    preserve: full
    target_namespace: originals
    repo_name: example-repo
    mentioned_projects: [example-repo, brain]
    ---

    operator-authored durable idea that should be preserved.
  MD

  auto_dir = File.join(inbox, "auto", "2026-05-28")
  FileUtils.mkdir_p(auto_dir)
  File.write(File.join(auto_dir, "auto.md"), <<~MD)
    ---
    type: draft
    source: stop-memory-capture
    content_hash: autohash
    session_id: session-abc
    capture_mode: session
    capture_segment_count: 2
    full_transcript_entry_count: 42
    previous_capture_entry_count: 17
    delta_transcript_entry_count: 25
    delta_transcript_end_entry_count: 42
    created_at: 2026-05-28T13:00:00+07:00
    repo_name: example-repo
    ---

    Redacted automatic capture candidate.

    ## Capture segment 1

    Baseline session material.

    ## Capture segment 2

    Incremental session material.
  MD

  File.write(File.join(auto_dir, "recursive-heading.md"), <<~MD)
    ---
    type: draft
    source: stop-memory-capture
    content_hash: recursivehash
    session_id: recursive-session
    capture_mode: session
    capture_segment_count: 1
    full_transcript_entry_count: 5
    created_at: 2026-05-28T14:00:00+07:00
    repo_name: example-repo
    ---

    Redacted automatic capture candidate.

    ## Capture segment 1

    - Captured at: 2026-05-28T14:00:00+07:00

    ## Full normalized transcript

    ````text
    A previous captured draft can appear verbatim inside the transcript.

    ## Capture segment 14

    This nested heading is transcript content, not a segment in this draft.
    ````
  MD

  File.write(File.join(inbox, "reviewed.md"), <<~MD)
    ---
    type: draft
    source: codex
    content_hash: reviewedhash
    created_at: 2026-05-27T13:05:00+07:00
    ---

    Already reviewed draft.
  MD

  future_path = File.join(inbox, "arrived-after-cutoff.md")
  File.write(future_path, <<~MD)
    ---
    type: draft
    source: codex
    created_at: 2026-05-27T12:00:00+07:00
    ---

    Draft written after this inventory snapshot started; it belongs to the next run.
  MD
  future_mtime = Time.now + 3600
  File.utime(future_mtime, future_mtime, future_path)

  File.write(
    File.join(inbox, "review-ledger.jsonl"),
    JSON.generate({ "content_hash" => "reviewedhash", "decision" => "discarded" }) + "\n" +
      JSON.generate({ "content_hash" => "autohash", "decision" => "discarded" }) + "\n"
  )

  system("ruby", INVENTORY, "--brain", brain, "--session", session, "--copy-sources", out: File::NULL, err: File::NULL) ||
    abort("inventory failed")
  inventory = JSON.parse(File.read(File.join(session, "inventory.json")))
  abort("reviewed draft was not filtered") unless inventory.fetch("total") == 3

  draft = inventory.fetch("drafts").find { |item| item["relative_path"] == "inbox/preserve.md" }
  abort("preserve draft missing from inventory") unless draft
  abort("memory_intent not parsed") unless draft["memory_intent"] == "preserve-full"
  abort("preserve marker not parsed") unless draft["preserve"] == "full"
  abort("target_namespace not parsed") unless draft["target_namespace"] == "originals"
  abort("inline mentioned_projects not parsed") unless draft["mentioned_projects"] == %w[example-repo brain]
  abort("created_at did not drive effective_date") unless draft["effective_date"] == "2026-05-27"
  abort("source snapshot missing for copied draft") unless File.file?(draft["source_snapshot"])

  auto_draft = inventory.fetch("drafts").find { |item| item["relative_path"] == "inbox/auto/2026-05-28/auto.md" }
  abort("nested auto draft missing from inventory") unless auto_draft
  abort("auto draft source not parsed") unless auto_draft["source"] == "stop-memory-capture"
  abort("auto draft session_id not parsed") unless auto_draft["session_id"] == "session-abc"
  abort("auto draft stale content_hash was not preserved") unless auto_draft["content_hash"] == "autohash"
  abort("auto draft dedupe_key incorrectly reused stale content_hash") if auto_draft["dedupe_key"] == "autohash"
  abort("auto draft session dedupe_key not derived from live file hash") unless auto_draft["dedupe_key"].start_with?("session-session-abc-")
  abort("auto draft capture mode not parsed") unless auto_draft["capture_mode"] == "session"
  abort("auto draft capture segment count not parsed") unless auto_draft["capture_segment_count"] == 2
  abort("auto draft transcript entry count not parsed") unless auto_draft["full_transcript_entry_count"] == 42
  abort("auto draft segment numbers not parsed") unless auto_draft["segment_numbers"] == [1, 2]
  abort("auto draft heading count not parsed") unless auto_draft["capture_segment_heading_count"] == 2
  abort("auto draft segment parse errors present") unless auto_draft["segment_parse_errors"] == []
  segment_manifest = auto_draft["segment_manifest"]
  abort("auto draft segment manifest missing") unless segment_manifest.is_a?(Array) && segment_manifest.length == 2
  abort("segment manifest ids wrong") unless segment_manifest.map { |segment| segment["segment_id"] } == %w[segment-1 segment-2]
  abort("segment manifest should mark explicit headings") unless segment_manifest.all? { |segment| segment["explicit_heading"] == true }
  abort("segment manifest sha missing") unless segment_manifest.all? { |segment| segment["sha256"].to_s.length == 64 }
  abort("segment manifest source anchor wrong") unless segment_manifest.first["source_anchor"] == "segment-1 capture section"
  abort("auto draft effective_date not parsed") unless auto_draft["effective_date"] == "2026-05-28"
  abort("auto draft source snapshot missing") unless File.file?(auto_draft["source_snapshot"])
  abort("auto source snapshot content mismatch") unless File.read(auto_draft["source_snapshot"]).include?("Redacted automatic capture candidate")

  recursive_draft = inventory.fetch("drafts").find { |item| item["relative_path"] == "inbox/auto/2026-05-28/recursive-heading.md" }
  abort("recursive-heading draft missing from inventory") unless recursive_draft
  abort("recursive transcript heading produced parse errors") unless recursive_draft["segment_parse_errors"] == []
  abort("recursive transcript heading counted as segment") unless recursive_draft["segment_numbers"] == [1]
  abort("session counts not generated") unless inventory.fetch("counts_by_session") == {
    "(no-session)" => 1,
    "recursive-session" => 1,
    "session-abc" => 1
  }
  session_group = inventory.fetch("session_groups").find { |group| group["session_id"] == "session-abc" }
  abort("session group missing") unless session_group
  abort("session group draft count wrong") unless session_group["draft_count"] == 1
  abort("session group path missing") unless session_group["drafts"] == ["inbox/auto/2026-05-28/auto.md"]
  abort("session group segment count wrong") unless session_group["capture_segment_count"] == 2
  abort("session group transcript entry count wrong") unless session_group["full_transcript_entry_count"] == 42
  abort("session group repo names wrong") unless session_group["repo_names"] == ["example-repo"]
  abort("session group segment parse errors wrong") unless session_group["segment_parse_errors"] == []

  include_session = File.join(brain, ".dreams", "include")
  system("ruby", INVENTORY, "--brain", brain, "--session", include_session, "--include-reviewed", out: File::NULL, err: File::NULL) ||
    abort("inventory include-reviewed failed")
  include_inventory = JSON.parse(File.read(File.join(include_session, "inventory.json")))
  reviewed = include_inventory.fetch("drafts").find { |item| item["content_hash"] == "reviewedhash" }
  abort("include-reviewed did not include reviewed draft") unless reviewed && reviewed["reviewed"] == true

  race_root = File.join(root, "race")
  race_brain = File.join(race_root, "brain")
  race_inbox = File.join(race_brain, "inbox")
  race_session = File.join(race_brain, ".dreams", "test")
  FileUtils.mkdir_p(race_inbox)
  File.write(File.join(race_inbox, "race.md"), <<~MD)
    ---
    type: draft
    source: codex
    created_at: 2026-05-27T13:00:00+07:00
    ---

    Original draft content that belongs to this inventory snapshot.
  MD
  monkeypatch = File.join(race_root, "mutate_before_cp.rb")
  File.write(monkeypatch, <<~RUBY)
    require "fileutils"

    module FileUtils
      class << self
        alias_method :dreams_inventory_original_cp, :cp

        def cp(src, dest, *args, **kwargs)
          if File.basename(src) == "race.md"
            File.write(src, <<~MD)
              ---
              type: draft
              source: codex
              created_at: 2026-05-27T13:00:00+07:00
              ---

              Mutated content written after the inventory read.
            MD
          end
          dreams_inventory_original_cp(src, dest, *args, **kwargs)
        end
      end
    end
  RUBY
  system("ruby", "-r", monkeypatch, INVENTORY, "--brain", race_brain, "--session", race_session, "--copy-sources", out: File::NULL, err: File::NULL) ||
    abort("race inventory failed")
  race_inventory = JSON.parse(File.read(File.join(race_session, "inventory.json")))
  race_draft = race_inventory.fetch("drafts").find { |item| item["relative_path"] == "inbox/race.md" }
  abort("race draft missing from inventory") unless race_draft
  race_snapshot = File.read(race_draft.fetch("source_snapshot"))
  abort("source snapshot copied post-read live mutation") if race_snapshot.include?("Mutated content written after the inventory read")
  abort("source snapshot lost original inventory content") unless race_snapshot.include?("Original draft content that belongs to this inventory snapshot")
end

puts "inventory regression tests passed"
