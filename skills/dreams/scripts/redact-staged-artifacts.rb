#!/usr/bin/env ruby
# Apply or check the brain redactor over staged Dreams artifacts.

require "fileutils"
require "json"
require "open3"
require "optparse"
require "tempfile"

options = {
  brain: File.join(Dir.home, "brain"),
  apply: false
}

OptionParser.new do |parser|
  parser.banner = "Usage: redact-staged-artifacts.rb [--brain PATH] [--apply]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--apply", "Rewrite non-idempotent staged files and re-stage them") { options[:apply] = true }
end.parse!

brain = File.expand_path(options[:brain])
redactor = File.join(brain, ".scripts", "redact_ai_source.rb")

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "brain redactor not found: #{redactor}" unless File.file?(redactor)

def git_output(brain, *args)
  output, status = Open3.capture2e("git", "-C", brain, *args)
  abort "git #{args.join(" ")} failed: #{output}" unless status.success?

  output
end

def staged_artifact_files(brain)
  git_output(brain, "diff", "--cached", "--name-only", "--diff-filter=ACMR")
    .lines
    .map(&:strip)
    .reject(&:empty?)
    .select { |path| path.match?(/\.(md|jsonl|json)\z/) }
    .select { |path| File.file?(File.join(brain, path)) }
end

def redacted_differs?(redactor, source_path, temp_path)
  ok = system("ruby", redactor, source_path, out: temp_path)
  abort "redactor failed for #{source_path}" unless ok

  !FileUtils.compare_file(source_path, temp_path)
end

changed = []
checked = []

staged_artifact_files(brain).each do |relative|
  source = File.join(brain, relative)
  checked << relative
  Tempfile.create("dreams-redacted-check") do |temp|
    temp.close
    next unless redacted_differs?(redactor, source, temp.path)

    changed << relative
    if options[:apply]
      FileUtils.mv(temp.path, source)
      git_output(brain, "add", "--", relative)
    end
  end
end

result = {
  ok: changed.empty? || options[:apply],
  mode: options[:apply] ? "apply" : "check",
  checked: checked.length,
  changed: changed.length,
  changed_files: changed
}

puts JSON.generate(result)
exit 1 if changed.any? && !options[:apply]
