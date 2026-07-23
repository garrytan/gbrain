#!/usr/bin/env ruby
# Stamp changed curated brain pages with the gbrain vector-index sync time.

require "optparse"
require "json"
require "open3"
require "time"

options = {
  brain: File.join(Dir.home, "brain"),
  timestamp: Time.now.iso8601,
  files: []
}

OptionParser.new do |parser|
  parser.banner = "Usage: stamp-indexed-at.rb [--brain PATH] [--timestamp ISO8601] [files...]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--timestamp ISO8601", "Successful sync/embed completion time") { |value| options[:timestamp] = value }
end.parse!(into: {})
options[:files] = ARGV

brain = File.expand_path(options[:brain])
timestamp = Time.parse(options[:timestamp]).iso8601
curated_prefixes = %w[
  people companies projects decisions gotchas concepts meetings originals
].freeze

abort "brain repo not found: #{brain}" unless Dir.exist?(File.join(brain, ".git"))

def curated_markdown_path?(path, prefixes)
  value = path.to_s.strip
  return false unless value.end_with?(".md")
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")

  prefixes.any? { |prefix| value.start_with?("#{prefix}/") }
end

def changed_curated_files(brain, prefixes)
  output, status = Open3.capture2e("git", "-C", brain, "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--", *prefixes)
  abort "git diff failed in #{brain}: #{output}" unless status.success?

  output.lines.map(&:strip).reject(&:empty?).select { |path| curated_markdown_path?(path, prefixes) }
end

files = if options[:files].empty?
  changed_curated_files(brain, curated_prefixes)
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
  unless text.start_with?("---\n")
    skipped << { file: rel, reason: "missing-frontmatter" }
    next
  end

  changed = false

  if text.match?(/^indexed_at:/)
    text = text.sub(/^indexed_at:.*$/, "indexed_at: #{timestamp}")
    changed = true
  elsif !text.match?(/^indexed_at:/)
    if text.match?(/^recorded_at:/)
      text = text.sub(/^(recorded_at:.*\n)/, "\\1indexed_at: #{timestamp}\n")
      changed = true
    else
      text = text.sub(/\A---\n/, "---\nindexed_at: #{timestamp}\n")
      changed = true
    end
  end

  if text.include?("indexed: pending-sync")
    text = text.gsub("indexed: pending-sync", "indexed: #{timestamp}")
    changed = true
  end

  if text.match?(/^- Indexed at:/)
    text = text.sub(/^- Indexed at:.*$/, "- Indexed at: #{timestamp}")
    changed = true
  end

  if changed
    File.write(path, text)
    updated << rel
  end
end

puts({
  timestamp: timestamp,
  updated: updated,
  skipped: skipped
}.to_json)
