#!/usr/bin/env ruby
# Regression tests for stamping modified existing curated pages after sync/embed.

require "fileutils"
require "tmpdir"

STAMPER = File.expand_path("stamp-indexed-at.rb", __dir__)
TIMESTAMP = "2026-05-27T14:00:00+07:00"

Dir.mktmpdir("brain-stamp-test") do |root|
  brain = File.join(root, "brain")
  project_dir = File.join(brain, "projects")
  FileUtils.mkdir_p(project_dir)

  path = File.join(project_dir, "existing.md")
  File.write(path, <<~MD)
    ---
    title: Existing Page
    recorded_at: 2026-05-26T12:00:00+07:00
    indexed_at: 2026-05-26T12:05:00+07:00
    ---
    # Existing Page

    Current truth v1.

    ---

    - 2026-05-26: Old evidence. [formed: 2026-05-26, recorded: 2026-05-26T12:00:00+07:00, indexed: 2026-05-26T12:05:00+07:00]

    ## Temporal Metadata
    - Indexed at: 2026-05-26T12:05:00+07:00
  MD

  system("git", "-C", brain, "init", "-q") || abort("git init failed")
  system("git", "-C", brain, "add", "projects/existing.md") || abort("git add failed")
  system(
    "git", "-C", brain,
    "-c", "user.name=dreams-test",
    "-c", "user.email=dreams-test@example.local",
    "commit", "-q", "-m", "baseline"
  ) || abort("git commit failed")

  text = File.read(path)
  text = text.sub("Current truth v1.", "Current truth v2 from new evidence.")
  text << "\n- 2026-05-27: New evidence. [formed: 2026-05-27, recorded: 2026-05-27T13:55:00+07:00, indexed: pending-sync]\n"
  text = text.sub(/^- Indexed at:.*$/, "- Indexed at: pending-sync")
  File.write(path, text)

  system("ruby", STAMPER, "--brain", brain, "--timestamp", TIMESTAMP, out: File::NULL, err: File::NULL) ||
    abort("stamp-indexed-at failed")

  stamped = File.read(path)
  abort("frontmatter indexed_at was not updated") unless stamped.include?("indexed_at: #{TIMESTAMP}")
  abort("timeline pending-sync was not updated") unless stamped.include?("indexed: #{TIMESTAMP}")
  abort("body Indexed at was not updated") unless stamped.include?("- Indexed at: #{TIMESTAMP}")

  private_path = File.join(brain, "private.md")
  File.write(private_path, <<~MD)
    ---
    indexed_at: 2026-05-26T12:05:00+07:00
    ---
    # Private
  MD

  system(
    "ruby", STAMPER, "--brain", brain, "--timestamp", TIMESTAMP,
    "originals/../private.md",
    out: File::NULL, err: File::NULL
  ) || abort("stamp-indexed-at traversal smoke failed")
  private_text = File.read(private_path)
  abort("unsafe traversal path was stamped") if private_text.include?("indexed_at: #{TIMESTAMP}")
end

puts "stamp-indexed-at regression tests passed"
