#!/usr/bin/env ruby
# Synchronize body "## Temporal Metadata" from curated page frontmatter.

require "date"
require "json"
require "open3"
require "optparse"
require "time"
require "yaml"

options = {
  brain: File.join(Dir.home, "brain"),
  all_curated: false,
  files: []
}

OptionParser.new do |parser|
  parser.banner = "Usage: sync-temporal-metadata.rb [--brain PATH] [--all-curated] [files...]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--all-curated", "Update every tracked/untracked curated markdown page") { options[:all_curated] = true }
end.parse!(into: {})
options[:files] = ARGV

brain = File.expand_path(options[:brain])
curated_prefixes = %w[people companies projects decisions gotchas concepts meetings originals].freeze

abort "brain repo not found: #{brain}" unless Dir.exist?(File.join(brain, ".git"))

def curated_markdown_path?(path, prefixes)
  value = path.to_s.strip
  return false unless value.end_with?(".md")
  return false if File.basename(value) == "README.md"
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")

  prefixes.any? { |prefix| value.start_with?("#{prefix}/") }
end

def git_paths(brain, *args)
  output, status = Open3.capture2e("git", "-C", brain, *args)
  abort "git #{args.join(" ")} failed in #{brain}: #{output}" unless status.success?
  output.lines.map(&:strip).reject(&:empty?)
end

def changed_curated_files(brain, prefixes)
  git_paths(brain, "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", *prefixes)
    .select { |path| curated_markdown_path?(path, prefixes) }
end

def untracked_curated_files(brain, prefixes)
  git_paths(brain, "ls-files", "--others", "--exclude-standard")
    .select { |path| curated_markdown_path?(path, prefixes) }
end

def tracked_curated_files(brain, prefixes)
  git_paths(brain, "ls-files", "--", *prefixes)
    .select { |path| curated_markdown_path?(path, prefixes) }
end

def parse_frontmatter(text)
  match = text.match(/\A---\s*\n(.*?)\n---\s*\n/m)
  return [nil, nil] unless match

  [YAML.safe_load(match[1], permitted_classes: [Date, Time], aliases: false), match.end(0)]
rescue Psych::Exception
  [nil, nil]
end

def temporal_value(value)
  case value
  when Time
    value.iso8601
  when Date
    value.iso8601
  else
    value.to_s.strip
  end
end

def replacement_section(frontmatter)
  effective_date = temporal_value(frontmatter["event_date"] || frontmatter["date"] || frontmatter["published"])
  formed_at = temporal_value(frontmatter["formed_at"])
  recorded_at = temporal_value(frontmatter["recorded_at"])
  indexed_at = temporal_value(frontmatter["indexed_at"])

  return nil if [effective_date, formed_at, recorded_at, indexed_at].any?(&:empty?)

  <<~MD.rstrip
    ## Temporal Metadata

    - Effective date: #{effective_date}
    - Formed at: #{formed_at}
    - Recorded at: #{recorded_at}
    - Indexed at: #{indexed_at}
  MD
end

files = if options[:files].empty?
  base = options[:all_curated] ? tracked_curated_files(brain, curated_prefixes) : changed_curated_files(brain, curated_prefixes)
  base + untracked_curated_files(brain, curated_prefixes)
else
  options[:files].map { |path| path.sub(%r{\A#{Regexp.escape(brain)}/?}, "") }
end

updated = []
skipped = []

files.uniq.sort.each do |rel|
  next unless curated_markdown_path?(rel, curated_prefixes)

  path = File.join(brain, rel)
  unless File.file?(path)
    skipped << { file: rel, reason: "not-found" }
    next
  end

  text = File.read(path)
  frontmatter, body_start = parse_frontmatter(text)
  unless frontmatter.is_a?(Hash) && body_start
    skipped << { file: rel, reason: "invalid-frontmatter" }
    next
  end

  replacement = replacement_section(frontmatter)
  unless replacement
    skipped << { file: rel, reason: "missing-frontmatter-temporal-field" }
    next
  end

  body = text[body_start..] || ""
  unless body.match?(/^##\s+Temporal Metadata\s*$/)
    skipped << { file: rel, reason: "missing-temporal-section" }
    next
  end

  new_body = body.sub(/^##\s+Temporal Metadata\s*\n.*?(?=^## |\n---\n|\z)/m, replacement + "\n\n")
  new_text = text[0...body_start] + new_body
  next if new_text == text

  File.write(path, new_text)
  updated << rel
end

puts({ ok: true, updated: updated, skipped: skipped }.to_json)
