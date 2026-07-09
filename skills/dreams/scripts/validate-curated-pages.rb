#!/usr/bin/env ruby
# Validate schema/safety basics for changed curated brain markdown pages.

require "date"
require "json"
require "open3"
require "optparse"
require "time"
require "yaml"

options = {
  brain: File.join(Dir.home, "brain"),
  allow_pending_index: false,
  all_curated: false,
  files: []
}

OptionParser.new do |parser|
  parser.banner = "Usage: validate-curated-pages.rb [--brain PATH] [--allow-pending-index] [--all-curated] [files...]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--allow-pending-index", "Allow indexed_at/indexed pending-sync before final sync") { options[:allow_pending_index] = true }
  parser.on("--all-curated", "Validate every tracked/untracked curated markdown page, not only changed files") { options[:all_curated] = true }
end.parse!(into: {})
options[:files] = ARGV

brain = File.expand_path(options[:brain])
curated_prefixes = %w[people companies projects decisions gotchas concepts meetings originals].freeze
required_frontmatter = %w[type title status visibility source formed_at recorded_at indexed_at confidence].freeze
forbidden_needles = %w[transcript_path git_remote raw_transcript connection_string private_key]

abort "brain repo not found: #{brain}" unless Dir.exist?(File.join(brain, ".git"))

def cyrillic?(value)
  value.to_s.match?(/\p{Cyrillic}/)
end

def curated_markdown_path?(path, prefixes)
  value = path.to_s.strip
  return false unless value.end_with?(".md")
  return false if File.basename(value) == "README.md"
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")

  prefixes.any? { |prefix| value.start_with?("#{prefix}/") }
end

def changed_curated_files(brain, prefixes)
  output, status = Open3.capture2e("git", "-C", brain, "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", *prefixes)
  abort "git diff failed in #{brain}: #{output}" unless status.success?

  output.lines.map(&:strip).reject(&:empty?).select { |path| curated_markdown_path?(path, prefixes) }
end

def untracked_curated_files(brain, prefixes)
  output, status = Open3.capture2e("git", "-C", brain, "ls-files", "--others", "--exclude-standard")
  abort "git ls-files failed in #{brain}: #{output}" unless status.success?

  output.lines.map(&:strip).reject(&:empty?).select { |path| curated_markdown_path?(path, prefixes) }
end

def tracked_curated_files(brain, prefixes)
  output, status = Open3.capture2e("git", "-C", brain, "ls-files", "--", *prefixes)
  abort "git ls-files failed in #{brain}: #{output}" unless status.success?

  output.lines.map(&:strip).reject(&:empty?).select { |path| curated_markdown_path?(path, prefixes) }
end

def parse_frontmatter(text)
  match = text.match(/\A---\s*\n(.*?)\n---\s*\n/m)
  return [nil, nil] unless match

  [YAML.safe_load(match[1], permitted_classes: [Date, Time], aliases: false), match.end(0)]
rescue Psych::Exception
  [nil, nil]
end

def present?(value)
  !value.nil? && !value.to_s.strip.empty?
end

def duplicate_sequence_values(value)
  return [] unless value.is_a?(Array)

  normalized = value.map { |item| item.to_s.strip.downcase }.reject(&:empty?)
  normalized.group_by { |item| item }.select { |_item, matches| matches.length > 1 }.keys
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

def body_temporal_metadata(body)
  match = body.match(/^##\s+Temporal Metadata\s*\n(.*?)(?=^## |\n---\n|\z)/m)
  return nil unless match

  labels = {
    "Effective date" => "effective_date",
    "Formed at" => "formed_at",
    "Recorded at" => "recorded_at",
    "Indexed at" => "indexed_at"
  }
  values = {}
  match[1].lines.each do |line|
    next unless line =~ /^\s*-\s*([^:]+):\s*(.*?)\s*$/
    key = labels[$1.strip]
    values[key] = $2.strip if key
  end
  values
end

files = if options[:files].empty?
  if options[:all_curated]
    tracked_curated_files(brain, curated_prefixes) + untracked_curated_files(brain, curated_prefixes)
  else
    changed_curated_files(brain, curated_prefixes) + untracked_curated_files(brain, curated_prefixes)
  end
else
  options[:files].map { |path| path.sub(%r{\A#{Regexp.escape(brain)}/?}, "") }
end

errors = []
files.uniq.sort.each do |rel|
  next unless curated_markdown_path?(rel, curated_prefixes)

  path = File.join(brain, rel)
  unless File.file?(path)
    errors << "#{rel}: file not found"
    next
  end

  text = File.read(path)
  if cyrillic?(text)
    errors << "#{rel}: curated indexed memory must be English-only; Cyrillic text is not allowed"
  end

  frontmatter, body_start = parse_frontmatter(text)
  unless frontmatter.is_a?(Hash) && body_start
    errors << "#{rel}: invalid or missing YAML frontmatter"
    next
  end

  required_frontmatter.each do |key|
    errors << "#{rel}: missing frontmatter #{key}" unless present?(frontmatter[key])
  end
  unless present?(frontmatter["date"]) || present?(frontmatter["event_date"]) || present?(frontmatter["published"])
    errors << "#{rel}: missing date/event_date/published"
  end
  unless frontmatter["confidence"].is_a?(Hash) && %w[low medium high].include?(frontmatter["confidence"]["value"].to_s)
    errors << "#{rel}: confidence.value must be low, medium, or high"
  end
  %w[aliases tags related supersedes].each do |key|
    next unless frontmatter.key?(key)
    unless frontmatter[key].is_a?(Array)
      errors << "#{rel}: frontmatter #{key} must be an array"
      next
    end

    duplicate_sequence_values(frontmatter[key]).each do |duplicate|
      errors << "#{rel}: duplicate frontmatter #{key} value #{duplicate.inspect}"
    end
  end

  if !options[:allow_pending_index] && text.include?("pending-sync")
    errors << "#{rel}: pending-sync remains after final index stamp"
  end
  if !options[:allow_pending_index] && frontmatter["indexed_at"].to_s == "pending-sync"
    errors << "#{rel}: frontmatter indexed_at is pending-sync"
  end

  body = text[body_start..] || ""
  temporal_body = body_temporal_metadata(body)
  errors << "#{rel}: missing ## Temporal Metadata" unless temporal_body
  if temporal_body
    expected_temporal = {
      "effective_date" => temporal_value(frontmatter["event_date"] || frontmatter["date"] || frontmatter["published"]),
      "formed_at" => temporal_value(frontmatter["formed_at"]),
      "recorded_at" => temporal_value(frontmatter["recorded_at"]),
      "indexed_at" => temporal_value(frontmatter["indexed_at"])
    }
    expected_temporal.each do |key, expected|
      if !present?(temporal_body[key])
        errors << "#{rel}: body Temporal Metadata missing #{key}"
      elsif present?(expected) && temporal_body[key] != expected
        errors << "#{rel}: body Temporal Metadata #{key} #{temporal_body[key].inspect} does not match frontmatter #{expected.inspect}"
      end
    end
  end
  compiled_truth_sections = [
    "## Current Understanding",
    "## Preserved Note",
    "## Decision",
    "## Symptom",
    "## Context"
  ]
  unless compiled_truth_sections.any? { |section| body.include?(section) }
    errors << "#{rel}: missing compiled-truth section"
  end
  errors << "#{rel}: missing timeline separator" unless body.lines.any? { |line| line.strip == "---" }
  errors << "#{rel}: missing ## Timeline" unless body.include?("## Timeline")

  forbidden_needles.each do |needle|
    errors << "#{rel}: forbidden raw metadata marker #{needle}" if text.include?(needle)
  end
  if text.match?(/\brenamed from\s+([A-Za-z0-9_$.-]+)\s+to\s+\1\b/i)
    errors << "#{rel}: self-referential rename wording detected"
  end
  if text.include?("older Dreams name") || text.include?("old Dreams wording")
    errors << "#{rel}: mechanical Dreams legacy wording detected"
  end
end

if errors.any?
  warn errors.join("\n")
  abort "curated page validation failed"
end

puts JSON.generate({ ok: true, checked: files.length })
