#!/usr/bin/env ruby
# Regression tests for synchronizing body Temporal Metadata from frontmatter.

require "fileutils"
require "English"
require "json"
require "shellwords"
require "tmpdir"

SYNCER = File.expand_path("sync-temporal-metadata.rb", __dir__)

def git!(brain, *args)
  ok = system("git", "-C", brain, *args, out: File::NULL, err: File::NULL)
  abort "git failed: #{args.join(" ")}" unless ok
end

def page(body_recorded_at: "2026-05-26", body_indexed_at: "pending-sync")
  <<~MD
    ---
    type: project
    title: Temporal Sync Test
    aliases: []
    tags: []
    status: confirmed
    visibility: local-only
    source: codex
    date: 2026-05-27
    formed_at: 2026-05-27T13:00:00+07:00
    recorded_at: 2026-05-27
    indexed_at: 2026-05-27T14:00:00+07:00
    last_verified: 2026-05-27
    confidence:
      value: medium
      notes: "Test fixture"
    related: []
    supersedes: []
    ---

    # Temporal Sync Test

    ## Temporal Metadata

    - Effective date: 2026-05-27
    - Formed at: 2026-05-27T13:00:00+07:00
    - Recorded at: #{body_recorded_at}
    - Indexed at: #{body_indexed_at}

    ## Current Understanding

    Durable reviewed memory.

    ---

    ## Timeline

    - **2026-05-27** | Evidence. [indexed: 2026-05-27T14:00:00+07:00]
  MD
end

Dir.mktmpdir("temporal-sync-test") do |root|
  brain = File.join(root, "brain")
  projects = File.join(brain, "projects")
  FileUtils.mkdir_p(projects)
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  git!(brain, "commit", "--allow-empty", "-m", "seed")

  path = File.join(projects, "temporal-sync.md")
  File.write(path, page)

  output = `ruby #{SYNCER.shellescape} --brain #{brain.shellescape} 2>&1`
  abort("sync-temporal-metadata failed: #{output}") unless $CHILD_STATUS.success?
  parsed = JSON.parse(output)
  abort("updated file missing from JSON output") unless parsed.fetch("updated").include?("projects/temporal-sync.md")

  synced = File.read(path)
  abort("body recorded_at was not synchronized") unless synced.include?("- Recorded at: 2026-05-27")
  abort("body indexed_at was not synchronized") unless synced.include?("- Indexed at: 2026-05-27T14:00:00+07:00")

  private_path = File.join(brain, "private.md")
  File.write(private_path, "## Temporal Metadata\n\n- Recorded at: stale\n")
  output = `ruby #{SYNCER.shellescape} --brain #{brain.shellescape} originals/../private.md 2>&1`
  abort("traversal smoke failed: #{output}") unless $CHILD_STATUS.success?
  abort("unsafe traversal path was modified") if File.read(private_path).include?("2026-05-27T14:00:00+07:00")
end

puts "sync-temporal-metadata regression tests passed"
