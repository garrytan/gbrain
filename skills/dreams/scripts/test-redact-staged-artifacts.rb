#!/usr/bin/env ruby
# Regression tests for staged redaction convergence helper.

require "fileutils"
require "json"
require "open3"
require "tmpdir"

HELPER = File.expand_path("redact-staged-artifacts.rb", __dir__)

Dir.mktmpdir("dreams-redact-staged") do |root|
  brain = File.join(root, "brain")
  FileUtils.mkdir_p(File.join(brain, ".scripts"))
  system("git", "-C", root, "init", "brain", out: File::NULL, err: File::NULL) || abort("git init failed")

  redactor = File.join(brain, ".scripts", "redact_ai_source.rb")
  File.write(redactor, <<~'RUBY')
    input = ARGV.empty? ? STDIN.read : File.read(ARGV.fetch(0))
    field = ["SECRET", "_TOKEN"].join
    print input.gsub(/#{field}='[^']+'/,"[REDACTED_SECRET_FIELD]")
  RUBY

  draft = File.join(brain, "draft.md")
  field = ["SECRET", "_TOKEN"].join
  File.write(draft, "safe line\n#{field}='dummy-value'\n")
  system("git", "-C", brain, "add", ".scripts/redact_ai_source.rb", "draft.md") || abort("git add failed")

  output, status = Open3.capture2e("ruby", HELPER, "--brain", brain)
  abort "check mode accepted non-idempotent staged artifact" if status.success?
  result = JSON.parse(output.lines.last)
  abort "check mode changed count mismatch" unless result["changed"] == 1 && result["changed_files"] == ["draft.md"]
  abort "check mode rewrote working file" unless File.read(draft).include?("dummy-value")

  output, status = Open3.capture2e("ruby", HELPER, "--brain", brain, "--apply")
  abort "apply mode failed: #{output}" unless status.success?
  result = JSON.parse(output.lines.last)
  abort "apply mode changed count mismatch" unless result["changed"] == 1
  abort "apply mode did not rewrite working file" if File.read(draft).include?("dummy-value")

  staged = git_show = nil
  staged, status = Open3.capture2e("git", "-C", brain, "show", ":draft.md")
  git_show = staged
  abort "git show staged blob failed: #{staged}" unless status.success?
  abort "apply mode did not update staged blob" if git_show.include?("dummy-value")

  output, status = Open3.capture2e("ruby", HELPER, "--brain", brain)
  abort "clean check mode failed after apply: #{output}" unless status.success?
  result = JSON.parse(output.lines.last)
  abort "clean check mode should have zero changes" unless result["changed"] == 0
end

puts "redact-staged-artifacts regression tests passed"
