#!/usr/bin/env ruby
# Build a deterministic inventory for ~/brain/inbox review sessions.

require "digest"
require "date"
require "fileutils"
require "json"
require "optparse"
require "time"
require "yaml"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  copy_sources: false,
  include_reviewed: false,
  ledger: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: inventory.rb [--brain PATH] [--session PATH] [--copy-sources] [--include-reviewed]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Review session path") { |value| options[:session] = value }
  parser.on("--copy-sources", "Copy source drafts into session/sources") { options[:copy_sources] = true }
  parser.on("--include-reviewed", "Include hashes already present in review ledger") { options[:include_reviewed] = true }
  parser.on("--ledger PATH", "Review ledger JSONL path") { |value| options[:ledger] = value }
end.parse!

brain = File.expand_path(options[:brain])
inbox = File.join(brain, "inbox")
session = File.expand_path(options[:session] || File.join(brain, ".dreams", Time.now.strftime("%Y%m%d-%H%M%S")))
ledger_path = File.expand_path(options[:ledger] || File.join(inbox, "review-ledger.jsonl"))
snapshot_cutoff = Time.now

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "inbox not found: #{inbox}" unless Dir.exist?(inbox)

def strip_quotes(value)
  value.to_s.strip.sub(/\A["']/, "").sub(/["']\z/, "")
end

def parse_frontmatter_fallback(source)
  data = {}
  current_key = nil
  source.each_line do |line|
    if (kv = line.match(/\A([A-Za-z0-9_-]+):\s*(.*?)\s*\z/))
      key = kv[1]
      value = kv[2].to_s.strip
      if value.empty? || value == "[]"
        data[key] = []
        current_key = key
      else
        data[key] = strip_quotes(value)
        current_key = nil
      end
    elsif current_key && (item = line.match(/\A\s*-\s*(.*?)\s*\z/))
      data[current_key] << strip_quotes(item[1])
    end
  end
  data
end

def normalize_frontmatter_value(value)
  case value
  when Time
    value.iso8601
  when Date
    value.iso8601
  when Array
    value.map { |item| normalize_frontmatter_value(item) }
  when Hash
    value.each_with_object({}) do |(key, item), memo|
      memo[key.to_s] = normalize_frontmatter_value(item)
    end
  else
    value
  end
end

def parse_frontmatter(text)
  match = text.match(/\A---\s*\n(.*?)\n---\s*\n/m)
  return {} unless match

  raw = YAML.safe_load(match[1], permitted_classes: [Date, Time], aliases: false)
  return {} unless raw.is_a?(Hash)

  raw.each_with_object({}) do |(key, value), memo|
    memo[key.to_s] = normalize_frontmatter_value(value)
  end
rescue Psych::Exception
  parse_frontmatter_fallback(match[1])
end

def reviewed_hashes(path)
  return {} unless File.file?(path)

  hashes = {}
  File.foreach(path) do |line|
    next if line.strip.empty?

    row = JSON.parse(line)
    hash = row["content_hash"] || row["dedupe_key"] || row["sha256"]
    hashes[hash.to_s] = row if hash && !hash.to_s.empty?
  rescue JSON::ParserError
    next
  end
  hashes
end

def date_part(value)
  return nil if value.to_s.strip.empty?

  Time.parse(value.to_s).strftime("%Y-%m-%d")
rescue ArgumentError
  nil
end

def integer_frontmatter(value)
  return nil if value.nil?

  text = value.to_s.strip
  return nil if text.empty?

  Integer(text)
rescue ArgumentError
  nil
end

def safe_key(value)
  key = value.to_s.strip.gsub(/[^A-Za-z0-9._-]+/, "-")
  key.empty? ? "unknown" : key
end

def session_capture?(frontmatter)
  source = frontmatter["source"].to_s
  session_id = frontmatter["session_id"].to_s.strip
  capture_mode = frontmatter["capture_mode"].to_s
  capture_segments = integer_frontmatter(frontmatter["capture_segment_count"]) || 0

  source == "stop-memory-capture" && !session_id.empty? && (capture_mode == "session" || capture_segments > 1)
end

def draft_session_key(draft)
  session_id = draft[:session_id].to_s.strip
  return session_id unless session_id.empty?

  "draft:#{draft[:dedupe_key]}"
end

def frontmatter_end_offset(text)
  match = text.match(/\A---\s*\n.*?\n---\s*\n/m)
  match ? match.end(0) : 0
end

def capture_segment_headings(text)
  headings = []
  offset = 0
  fence_marker = nil
  text.each_line do |line|
    if (fence = line.match(/\A(`{3,}|~{3,})/))
      marker = fence[1]
      if fence_marker
        fence_marker = nil if marker.start_with?(fence_marker)
      else
        fence_marker = marker
      end
    elsif fence_marker.nil? && (match = line.match(/\A##\s+Capture segment\s+(\d+)\b/i))
      headings << {
        number: match[1].to_i,
        offset: offset,
        line: line.strip
      }
    end
    offset += line.bytesize
  end
  headings
end

def capture_segment_info(text, declared_count)
  headings = capture_segment_headings(text)
  numbers = headings.map { |heading| heading[:number] }
  errors = []
  duplicates = numbers.select { |number| numbers.count(number) > 1 }.uniq
  errors << "duplicate capture segment headings: #{duplicates.join(", ")}" if duplicates.any?
  errors << "capture segment headings are not monotonic" if numbers != numbers.sort

  declared = declared_count.to_i
  if declared.positive?
    expected = (1..declared).to_a
    missing = expected - numbers.uniq
    # The original full baseline can predate explicit segment headings. Treat
    # segment 1 as implicit when later appended segments are present.
    missing_without_implicit_baseline = missing - [1]
    extra = numbers.uniq - expected
    errors << "missing capture segment headings: #{missing_without_implicit_baseline.join(", ")}" if missing_without_implicit_baseline.any?
    errors << "out-of-range capture segment headings: #{extra.join(", ")}" if extra.any?
    segment_numbers = expected
  else
    segment_numbers = numbers.uniq.sort
  end

  manifest = segment_numbers.map do |number|
    heading = headings.find { |item| item[:number] == number }
    if heading
      start_offset = heading[:offset]
      next_heading = headings.select { |item| item[:offset] > start_offset }.min_by { |item| item[:offset] }
      end_offset = next_heading ? next_heading[:offset] : text.bytesize
      section = text.byteslice(start_offset...end_offset).to_s
      explicit = true
      source_anchor = "segment-#{number} capture section"
    else
      start_offset = frontmatter_end_offset(text)
      first_heading = headings.min_by { |item| item[:offset] }
      end_offset = first_heading ? first_heading[:offset] : text.bytesize
      section = text.byteslice(start_offset...end_offset).to_s
      explicit = false
      source_anchor = "segment-#{number} implicit baseline before capture segment headings"
    end

    {
      segment_id: "segment-#{number}",
      segment_index: number,
      explicit_heading: explicit,
      source_anchor: source_anchor,
      bytes: section.bytesize,
      chars: section.length,
      sha256: Digest::SHA256.hexdigest(section)
    }
  end

  {
    segment_numbers: segment_numbers,
    capture_segment_heading_count: numbers.length,
    segment_manifest: manifest,
    segment_parse_errors: errors
  }
end

def draft_dedupe_key(frontmatter, sha256)
  content_hash = frontmatter["content_hash"].to_s
  if session_capture?(frontmatter)
    return "session-#{safe_key(frontmatter['session_id'])}-#{sha256[0, 16]}"
  end

  content_hash.empty? ? sha256[0, 16] : content_hash
end

reviewed = reviewed_hashes(ledger_path)
draft_paths = Dir.glob(File.join(inbox, "**", "*.md"))
  .reject { |path| File.basename(path) == "README.md" }
  .sort
source_text_by_path = {}

drafts = draft_paths.map do |path|
  initial_mtime = File.mtime(path)
  next nil if initial_mtime > snapshot_cutoff

  text = File.read(path)
  mtime = File.mtime(path)
  next nil if mtime > snapshot_cutoff

  source_text_by_path[path] = text

  frontmatter = parse_frontmatter(text)
  sha256 = Digest::SHA256.hexdigest(text)
  content_hash = frontmatter["content_hash"].to_s
  dedupe_key = draft_dedupe_key(frontmatter, sha256)
  rel = path.sub(%r{\A#{Regexp.escape(brain)}/?}, "")
  reviewed_row = reviewed[dedupe_key] || reviewed[sha256]
  formed_at = frontmatter["formed_at"].to_s
  formed_at = frontmatter["created_at"].to_s if formed_at.empty?
  segment_info = capture_segment_info(text, integer_frontmatter(frontmatter["capture_segment_count"]))
  effective_date = date_part(frontmatter["event_date"]) ||
    date_part(frontmatter["date"]) ||
    date_part(frontmatter["published"]) ||
    date_part(formed_at) ||
    date_part(mtime.iso8601)

  {
    path: path,
    relative_path: rel,
    sha256: sha256,
    content_hash: content_hash.empty? ? nil : content_hash,
    dedupe_key: dedupe_key,
    bytes: text.bytesize,
    chars: text.length,
    mtime: mtime.iso8601,
    type: frontmatter["type"],
    status: frontmatter["status"],
    source: frontmatter["source"],
    hook_event: frontmatter["hook_event"],
    session_id: frontmatter["session_id"],
    capture_mode: frontmatter["capture_mode"],
    capture_segment_count: integer_frontmatter(frontmatter["capture_segment_count"]),
    segment_numbers: segment_info[:segment_numbers],
    capture_segment_heading_count: segment_info[:capture_segment_heading_count],
    segment_manifest: segment_info[:segment_manifest],
    segment_parse_errors: segment_info[:segment_parse_errors],
    previous_capture_entry_count: integer_frontmatter(frontmatter["previous_capture_entry_count"]),
    delta_transcript_entry_count: integer_frontmatter(frontmatter["delta_transcript_entry_count"]),
    delta_transcript_end_entry_count: integer_frontmatter(frontmatter["delta_transcript_end_entry_count"]),
    full_transcript_entry_count: integer_frontmatter(frontmatter["full_transcript_entry_count"]),
    created_at: frontmatter["created_at"],
    formed_at: formed_at.empty? ? nil : formed_at,
    date: frontmatter["date"],
    event_date: frontmatter["event_date"],
    recorded_at: frontmatter["recorded_at"],
    indexed_at: frontmatter["indexed_at"],
    memory_intent: frontmatter["memory_intent"],
    preserve: frontmatter["preserve"],
    target_namespace: frontmatter["target_namespace"],
    effective_date: effective_date,
    repo_name: frontmatter["repo_name"],
    mentioned_projects: Array(frontmatter["mentioned_projects"]),
    reviewed: !reviewed_row.nil?,
    reviewed_decision: reviewed_row && reviewed_row["decision"]
  }
end
drafts = drafts.compact

drafts = drafts.reject { |draft| draft[:reviewed] } unless options[:include_reviewed]
drafts.each { |draft| draft[:session_key] = draft_session_key(draft) }

FileUtils.mkdir_p(session)
FileUtils.mkdir_p(File.join(session, "sources")) if options[:copy_sources]

if options[:copy_sources]
  drafts.each do |draft|
    target = File.join(session, "sources", "#{draft[:dedupe_key]}-#{File.basename(draft[:path])}")
    File.write(target, source_text_by_path.fetch(draft[:path]))
    draft[:source_snapshot] = target
  end
end

counts = drafts.each_with_object(Hash.new(0)) do |draft, memo|
  key = draft[:source].to_s.empty? ? "unknown" : draft[:source].to_s
  memo[key] += 1
end

counts_by_session = drafts.each_with_object(Hash.new(0)) do |draft, memo|
  key = draft[:session_id].to_s.strip
  key = "(no-session)" if key.empty?
  memo[key] += 1
end

session_groups = drafts
  .group_by { |draft| draft[:session_key] }
  .map do |session_key, group_drafts|
    session_ids = group_drafts.map { |draft| draft[:session_id].to_s.strip }.reject(&:empty?).uniq.sort
    capture_segment_counts = group_drafts.map { |draft| draft[:capture_segment_count] }.compact
    transcript_entry_counts = group_drafts.map { |draft| draft[:full_transcript_entry_count] }.compact
    {
      session_key: session_key,
      session_id: session_ids.first,
      draft_count: group_drafts.length,
      drafts: group_drafts.map { |draft| draft[:relative_path] }.sort,
      source_snapshots: group_drafts.map { |draft| draft[:source_snapshot].to_s }.reject(&:empty?).sort,
      sources: group_drafts.map { |draft| draft[:source].to_s }.reject(&:empty?).uniq.sort,
      repo_names: group_drafts.map { |draft| draft[:repo_name].to_s }.reject(&:empty?).uniq.sort,
      mentioned_projects: group_drafts.flat_map { |draft| draft[:mentioned_projects] }.map(&:to_s).reject(&:empty?).uniq.sort,
      capture_mode: group_drafts.map { |draft| draft[:capture_mode].to_s }.reject(&:empty?).uniq.sort.join("+"),
      capture_segment_count: capture_segment_counts.empty? ? nil : capture_segment_counts.sum,
      segment_numbers: group_drafts.flat_map { |draft| Array(draft[:segment_numbers]) }.uniq.sort,
      segment_parse_errors: group_drafts.flat_map { |draft| Array(draft[:segment_parse_errors]) }.uniq.sort,
      segment_manifest: group_drafts.flat_map do |draft|
        Array(draft[:segment_manifest]).map do |segment|
          segment.merge(source_path: draft[:relative_path])
        end
      end,
      full_transcript_entry_count: transcript_entry_counts.empty? ? nil : transcript_entry_counts.max,
      bytes: group_drafts.sum { |draft| draft[:bytes].to_i },
      chars: group_drafts.sum { |draft| draft[:chars].to_i },
      effective_dates: group_drafts.map { |draft| draft[:effective_date].to_s }.reject(&:empty?).uniq.sort
    }
  end
  .sort_by { |group| [group[:session_id] ? 0 : 1, group[:session_key].to_s] }

inventory = {
  generated_at: snapshot_cutoff.iso8601,
  brain_root: brain,
  inbox_root: inbox,
  session: session,
  ledger_path: ledger_path,
  include_reviewed: options[:include_reviewed],
  total: drafts.length,
  counts_by_source: counts.sort.to_h,
  counts_by_session: counts_by_session.sort.to_h,
  session_groups: session_groups,
  drafts: drafts
}

File.write(File.join(session, "inventory.json"), JSON.pretty_generate(inventory) + "\n")

summary = +"# Draft Inventory\n\n"
summary << "- Generated at: #{inventory[:generated_at]}\n"
summary << "- Brain: #{brain}\n"
summary << "- Inbox: #{inbox}\n"
summary << "- Drafts: #{drafts.length}\n\n"
summary << "## Session Groups\n\n"
summary << "| Session | Drafts | Segments | Entries | Repos | Segment parse errors | Paths |\n"
summary << "|---|---:|---:|---:|---|---|---|\n"
session_groups.each do |group|
  paths = group[:drafts].map { |path| "`#{path}`" }.join("<br>")
  repos = group[:repo_names].join(", ")
  errors = Array(group[:segment_parse_errors]).empty? ? "" : Array(group[:segment_parse_errors]).join("<br>")
  summary << "| `#{group[:session_id] || group[:session_key]}` | #{group[:draft_count]} | #{group[:capture_segment_count] || ""} | #{group[:full_transcript_entry_count] || ""} | #{repos} | #{errors} | #{paths} |\n"
end
summary << "\n## Drafts\n\n"
summary << "| Path | Source | Intent | Target | Repo | Effective date | Formed at | Hash | Chars | Reviewed |\n"
summary << "|---|---|---|---|---|---|---|---|---:|---|\n"
drafts.each do |draft|
  intent = [draft[:memory_intent], draft[:preserve]].compact.map { |value| value.to_s.strip }.reject(&:empty?).join("/")
  summary << "| `#{draft[:relative_path]}` | #{draft[:source] || ""} | #{intent} | #{draft[:target_namespace] || ""} | #{draft[:repo_name] || ""} | #{draft[:effective_date] || ""} | #{draft[:formed_at] || ""} | `#{draft[:dedupe_key]}` | #{draft[:chars]} | #{draft[:reviewed] ? "yes" : "no"} |\n"
end

File.write(File.join(session, "inventory.md"), summary)
puts JSON.generate({ session: session, total: drafts.length, inventory: File.join(session, "inventory.json") })
