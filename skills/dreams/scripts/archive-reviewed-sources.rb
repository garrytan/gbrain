#!/usr/bin/env ruby
# Archive reviewed Dreams sources from frozen inventory snapshots.

require "digest"
require "fileutils"
require "json"
require "optparse"
require "pathname"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  inventory: nil,
  ledger: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: archive-reviewed-sources.rb --session PATH [--brain PATH] [--inventory PATH] [--ledger PATH]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--inventory PATH", "Inventory JSON path") { |value| options[:inventory] = value }
  parser.on("--ledger PATH", "Review ledger JSONL path") { |value| options[:ledger] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?

brain = File.expand_path(options[:brain])
session = File.expand_path(options[:session])
inventory_path = File.expand_path(options[:inventory] || File.join(session, "inventory.json"))
ledger_path = File.expand_path(options[:ledger] || File.join(brain, "inbox", "review-ledger.jsonl"))
session_id = File.basename(session)
manifest_path = File.join(brain, "archive", "dreams-session-audits", session_id, "archive-manifest.json")

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "session not found: #{session}" unless Dir.exist?(session)
abort "inventory not found: #{inventory_path}" unless File.file?(inventory_path)
abort "ledger not found: #{ledger_path}" unless File.file?(ledger_path)

def repo_relative(path, brain)
  path.to_s.sub(%r{\A#{Regexp.escape(brain)}/?}, "")
end

def resolve_repo_path(path, brain)
  value = path.to_s
  return value if value.empty? || value.start_with?(File::SEPARATOR)

  File.expand_path(value, brain)
end

def session_keys(session, brain)
  relative = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
  [session, relative].compact.uniq
end

def safe_archive_path?(path)
  value = path.to_s
  value.start_with?("archive/inbox-reviewed/") &&
    value.end_with?(".md") &&
    !value.start_with?("/") &&
    !value.split("/").include?("..")
end

def sha256_file(path)
  Digest::SHA256.file(path).hexdigest
end

inventory = JSON.parse(File.read(inventory_path))
drafts_by_path = Array(inventory.fetch("drafts")).each_with_object({}) do |draft, memo|
  path = draft["relative_path"].to_s
  memo[path] = draft unless path.empty?
end

rows = []
File.foreach(ledger_path).with_index(1) do |line, lineno|
  next if line.strip.empty?

  row = JSON.parse(line)
  rows << [lineno, row] if session_keys(session, brain).include?(row["session"].to_s)
rescue JSON::ParserError => error
  abort "invalid JSONL row at #{ledger_path}:#{lineno}: #{error.message}"
end

existing_manifest_entries = {}
if File.file?(manifest_path)
  begin
    manifest = JSON.parse(File.read(manifest_path))
    if manifest["schema"] == "dreams-archive-manifest.v1" &&
        session_keys(session, brain).include?(manifest["session"].to_s)
      Array(manifest["entries"]).each do |entry|
        next unless entry.is_a?(Hash)

        source_path = entry["source_path"].to_s
        existing_manifest_entries[source_path] = entry unless source_path.empty?
      end
    end
  rescue JSON::ParserError
    existing_manifest_entries = {}
  end
end

entries = []
counts = Hash.new(0)

rows.each do |lineno, row|
  next if row["preservation_mode"].to_s == "blocked-safety"

  source_path = row["source_path"].to_s
  archived_path = row["archived_path"].to_s
  draft = drafts_by_path[source_path]
  abort "#{ledger_path}:#{lineno}: source_path is not in inventory: #{source_path}" unless draft
  abort "#{ledger_path}:#{lineno}: archived_path must be archive/inbox-reviewed/*.md" unless safe_archive_path?(archived_path)

  expected_sha = draft["sha256"].to_s.strip
  abort "#{inventory_path}: #{source_path} missing sha256; cannot prove reviewed source snapshot" if expected_sha.empty?

  snapshot_path = resolve_repo_path(draft["source_snapshot"], brain)
  abort "#{inventory_path}: #{source_path} missing source_snapshot" if snapshot_path.to_s.empty?
  abort "#{inventory_path}: source_snapshot missing for #{source_path}: #{draft["source_snapshot"]}" unless File.file?(snapshot_path)

  snapshot_sha = sha256_file(snapshot_path)
  abort "#{inventory_path}: source_snapshot sha mismatch for #{source_path}" unless snapshot_sha == expected_sha

  archive_abs = File.join(brain, archived_path)
  FileUtils.mkdir_p(File.dirname(archive_abs))
  existing_entry = existing_manifest_entries[source_path]
  if File.file?(archive_abs)
    current_archive_sha = sha256_file(archive_abs)
    if current_archive_sha == expected_sha
      archived_pre_redaction_sha = expected_sha
      counts["archive_already_matches_snapshot"] += 1
    elsif existing_entry &&
        existing_entry["archived_path"].to_s == archived_path &&
        existing_entry["archived_pre_redaction_sha256"].to_s == expected_sha
      archived_pre_redaction_sha = expected_sha
      counts["kept_existing_post_redaction_archive"] += 1
    else
      abort "#{archived_path}: existing archive does not match reviewed snapshot and has no manifest proof"
    end
  else
    FileUtils.cp(snapshot_path, archive_abs)
    archived_pre_redaction_sha = sha256_file(archive_abs)
    abort "#{archived_path}: archived copy does not match reviewed snapshot" unless archived_pre_redaction_sha == expected_sha
    counts["archived_from_snapshot"] += 1
  end

  live_abs = File.join(brain, source_path)
  live_sha = File.file?(live_abs) ? sha256_file(live_abs) : nil
  live_status = if live_sha.nil?
                  "missing"
                elsif live_sha == expected_sha
                  FileUtils.rm_f(live_abs)
                  counts["removed_unchanged_live_source"] += 1
                  "removed_unchanged"
                else
                  counts["left_changed_live_source_pending"] += 1
                  "left_changed_pending"
                end

  entries << {
    "source_path" => source_path,
    "source_snapshot" => repo_relative(snapshot_path, brain),
    "archived_path" => archived_path,
    "inventory_sha256" => expected_sha,
    "source_snapshot_sha256" => snapshot_sha,
    "archived_pre_redaction_sha256" => archived_pre_redaction_sha,
    "live_source_sha256_at_archive" => live_sha,
    "live_source_status" => live_status
  }
end

manifest = {
  "schema" => "dreams-archive-manifest.v1",
  "session" => Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s,
  "inventory" => repo_relative(inventory_path, brain),
  "ledger" => repo_relative(ledger_path, brain),
  "entries" => entries
}

FileUtils.mkdir_p(File.dirname(manifest_path))
File.write(manifest_path, JSON.pretty_generate(manifest) + "\n")

puts JSON.generate({
  ok: true,
  session: manifest["session"],
  archive_manifest: repo_relative(manifest_path, brain),
  counts: counts.sort.to_h
})
