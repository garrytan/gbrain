#!/usr/bin/env ruby
# Regression tests for changed curated page schema validation.

require "fileutils"
require "tmpdir"

VALIDATOR = File.expand_path("validate-curated-pages.rb", __dir__)

def git!(brain, *args)
  ok = system("git", "-C", brain, *args, out: File::NULL, err: File::NULL)
  abort "git failed: #{args.join(" ")}" unless ok
end

def page(indexed_at = "2026-05-27T14:00:00+07:00")
  <<~MD
    ---
    type: original
    title: Memory Quality
    aliases: []
    tags: []
    status: confirmed
    visibility: local-only
    source: codex
    date: 2026-05-27
    formed_at: 2026-05-27T13:00:00+07:00
    recorded_at: 2026-05-27
    indexed_at: #{indexed_at}
    last_verified: 2026-05-27
    confidence:
      value: medium
      notes: "Test fixture"
    related: []
    supersedes: []
    ---

    # Memory Quality

    ## Temporal Metadata

    - Effective date: 2026-05-27
    - Formed at: 2026-05-27T13:00:00+07:00
    - Recorded at: 2026-05-27
    - Indexed at: #{indexed_at}

    ## Current Understanding

    Durable reviewed memory.

    ---

    ## Timeline

    - **2026-05-27** | Evidence. [indexed: #{indexed_at}]
  MD
end

Dir.mktmpdir("curated-pages-test") do |root|
  brain = File.join(root, "brain")
  originals = File.join(brain, "originals")
  FileUtils.mkdir_p(originals)
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  git!(brain, "commit", "--allow-empty", "-m", "seed")

  valid = File.join(originals, "memory-quality.md")
  File.write(valid, page)
  git!(brain, "add", "originals/memory-quality.md")
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("valid curated page rejected") unless ok

  File.write(valid, page("pending-sync"))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("pending-sync accepted without flag") if ok
  ok = system("ruby", VALIDATOR, "--brain", brain, "--allow-pending-index", out: File::NULL, err: File::NULL)
  abort("pending-sync rejected with allow flag") unless ok

  File.write(valid, page.sub("## Temporal Metadata\n", ""))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("missing temporal metadata accepted") if ok

  File.write(valid, page.sub("- Recorded at: 2026-05-27", "- Recorded at: 2026-05-26"))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("stale body recorded_at accepted") if ok

  File.write(valid, page.sub("aliases: []", "aliases:\n    - Memory Quality\n    - memory quality"))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("duplicate aliases accepted") if ok

  File.write(valid, page.sub("Durable reviewed memory.", "The workflow was renamed from Dreams to Dreams."))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("self-referential rename wording accepted") if ok

  File.write(valid, page.sub("Durable reviewed memory.", "Dreams replaced the older Dreams name."))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("mechanical Dreams legacy wording accepted") if ok

  File.write(valid, page + "\ntranscript_path: /private/raw.jsonl\n")
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("raw transcript metadata accepted") if ok

  File.write(valid, page.sub("Durable reviewed memory.", "Русский текст не должен попасть в curated memory."))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("Russian text accepted in curated page") if ok

  File.write(valid, page)
  gotchas = File.join(brain, "gotchas")
  FileUtils.mkdir_p(gotchas)
  gotcha = File.join(gotchas, "memory-gotcha.md")
  File.write(gotcha, page.sub("type: original", "type: gotcha").sub("## Current Understanding", "## Symptom"))
  git!(brain, "add", "gotchas/memory-gotcha.md")
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("gotcha Symptom section rejected") unless ok

  unstaged = File.join(originals, "unstaged.md")
  File.write(unstaged, page.sub("## Temporal Metadata\n", ""))
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("untracked curated page was not validated") if ok
end

Dir.mktmpdir("curated-pages-untracked-valid-test") do |root|
  brain = File.join(root, "brain")
  originals = File.join(brain, "originals")
  FileUtils.mkdir_p(originals)
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")
  git!(brain, "commit", "--allow-empty", "-m", "seed")

  File.write(File.join(originals, "valid-untracked.md"), page)
  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("valid untracked curated page rejected") unless ok
end

Dir.mktmpdir("curated-pages-all-curated-test") do |root|
  brain = File.join(root, "brain")
  originals = File.join(brain, "originals")
  projects = File.join(brain, "projects")
  FileUtils.mkdir_p([originals, projects])
  git!(brain, "init")
  git!(brain, "config", "user.email", "test@example.invalid")
  git!(brain, "config", "user.name", "Dreams Test")

  File.write(File.join(originals, "valid.md"), page)
  File.write(File.join(originals, "README.md"), "# Originals\n\nDirectory documentation, not indexed memory.\n")
  File.write(
    File.join(projects, "existing-russian.md"),
    page.sub("type: original", "type: project").sub("Durable reviewed memory.", "Existing Русский text."),
  )
  git!(brain, "add", ".")
  git!(brain, "commit", "-m", "seed curated pages")

  ok = system("ruby", VALIDATOR, "--brain", brain, out: File::NULL, err: File::NULL)
  abort("default changed-only scan should ignore unchanged tracked pages") unless ok

  ok = system("ruby", VALIDATOR, "--brain", brain, "--all-curated", out: File::NULL, err: File::NULL)
  abort("all-curated scan accepted existing Cyrillic indexed memory") if ok

  File.write(File.join(projects, "existing-russian.md"), page.sub("type: original", "type: project"))
  git!(brain, "add", ".")
  git!(brain, "commit", "-m", "translate curated page")

  ok = system("ruby", VALIDATOR, "--brain", brain, "--all-curated", out: File::NULL, err: File::NULL)
  abort("all-curated scan rejected valid tracked curated pages") unless ok
end

puts "validate-curated-pages regression tests passed"
