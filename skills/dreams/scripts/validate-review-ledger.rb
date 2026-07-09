#!/usr/bin/env ruby
# Validate quality fields for the current ~/brain dreams ledger entries.

require "json"
require "digest"
require "open3"
require "optparse"
require "pathname"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  ledger: nil,
  inventory: nil,
  require_target_diff: false,
  require_proposal_artifacts: false,
  require_proposal_current_match: false,
  require_evidence_drilldown: false
}

OptionParser.new do |parser|
  parser.banner = "Usage: validate-review-ledger.rb --session PATH [--brain PATH] [--ledger PATH] [--inventory PATH]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Review session path") { |value| options[:session] = value }
  parser.on("--ledger PATH", "Review ledger JSONL path") { |value| options[:ledger] = value }
  parser.on("--inventory PATH", "Session inventory JSON path") { |value| options[:inventory] = value }
  parser.on("--require-target-diff", "Require target_actions to match git diff against HEAD") { options[:require_target_diff] = true }
  parser.on("--require-proposal-artifacts", "Require full-file proposal mirrors for curated target_actions") { options[:require_proposal_artifacts] = true }
  parser.on("--require-proposal-current-match", "Require proposal mirrors to match current curated files") do
    options[:require_proposal_artifacts] = true
    options[:require_proposal_current_match] = true
  end
  parser.on("--require-evidence-drilldown", "Require archived_path/source_excerpt_summary and curated timeline source refs for evidence lookup") do
    options[:require_evidence_drilldown] = true
  end
end.parse!

abort "--session is required" if options[:session].to_s.empty?

brain = File.expand_path(options[:brain])
session = File.expand_path(options[:session])
ledger_path = File.expand_path(options[:ledger] || File.join(brain, "inbox", "review-ledger.jsonl"))
inventory_path = File.expand_path(options[:inventory] || File.join(session, "inventory.json"))

abort "brain repo not found: #{brain}" unless Dir.exist?(brain)
abort "brain git repo not found: #{brain}" if options[:require_target_diff] && !Dir.exist?(File.join(brain, ".git"))

rel_session = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
session_keys = [session, rel_session].compact.uniq

allowed_modes = %w[preserve-full preserve-substantial synthesize source-note discard duplicate blocked-safety]
allowed_decisions = %w[promoted low-confidence-promoted source-note discarded duplicate blocked-safety]
allowed_quality = %w[low medium high]
allowed_unit_kinds = %w[authored-thinking business-idea strategy decision preference project-fact gotcha person-context company-context meeting-event operational-evidence source-evidence status-noise duplicate unsafe other-durable other-ephemeral]
allowed_target_actions = %w[create update append-timeline supersede no-change-duplicate]
allowed_coverage_sources = %w[full-draft source-snapshot full-draft-and-snapshot]
allowed_loss_risks = %w[low medium high]
durable_unit_kinds = %w[authored-thinking business-idea strategy decision preference project-fact gotcha person-context company-context meeting-event operational-evidence source-evidence other-durable]
non_durable_unit_kinds = %w[status-noise duplicate unsafe other-ephemeral]
curated_prefixes = %w[people companies projects decisions gotchas concepts meetings originals]
score_fields = %w[future_retrieval durability specificity authorship fidelity total]
generic_quality_reasons = %w[useful interesting important durable good maybe ok]
ALLOWED_SESSION_SEGMENT_STATUSES = %w[reviewed discarded duplicate unsafe blocked].freeze

def present?(value)
  !value.nil? && !value.to_s.strip.empty?
end

def array_present?(value)
  value.is_a?(Array) && value.any? { |item| present?(item) }
end

def score_valid?(score, fields)
  return false unless score.is_a?(Hash)
  return false unless fields.all? { |field| score.key?(field) }
  return false unless (score.keys - fields).empty?

  subtotal = 0
  fields.each do |field|
    value = score[field]
    return false unless value.is_a?(Integer)
    if field == "total"
      return false unless value.between?(0, 15)
    else
      return false unless value.between?(0, 3)
      subtotal += value
    end
  end
  score["total"] == subtotal
end

def mode_rank(mode)
  {
    "discard" => 0,
    "duplicate" => 0,
    "blocked-safety" => 0,
    "source-note" => 1,
    "synthesize" => 2,
    "preserve-substantial" => 3,
    "preserve-full" => 4
  }.fetch(mode, -1)
end

def score_total(score)
  score.is_a?(Hash) && score["total"].is_a?(Integer) ? score["total"] : nil
end

def score_dimension(score, field)
  score.is_a?(Hash) && score[field].is_a?(Integer) ? score[field] : nil
end

def score_recommended_min_rank(score)
  return 0 unless score.is_a?(Hash)

  total = score_total(score) || 0
  authorship = score_dimension(score, "authorship") || 0
  fidelity = score_dimension(score, "fidelity") || 0

  if (total >= 11 && fidelity >= 2) || authorship == 3 || fidelity == 3
    4
  elsif (total >= 7 && fidelity >= 2) || authorship >= 2
    3
  elsif total >= 7
    2
  elsif total >= 4
    1
  else
    0
  end
end

def placeholder_text?(value)
  text = value.to_s.downcase
  [
    "specific authored claim or passage being evaluated",
    "sanitized source phrase",
    "local source-snapshot section",
    "source excerpt or heading",
    "all durable source material is represented"
  ].any? { |placeholder| text.include?(placeholder) }
end

def cyrillic?(value)
  value.to_s.match?(/\p{Cyrillic}/)
end

def english_only!(errors, prefix, label, value)
  errors << "#{prefix}: #{label} must be English-only; Cyrillic text is not allowed" if cyrillic?(value)
end

def normalized_keys(value, brain)
  value = value.to_s.strip
  return [] if value.empty?

  keys = [value]
  brain_prefix = "#{brain}/"
  keys << value.delete_prefix(brain_prefix) if value.start_with?(brain_prefix)
  keys.uniq
end

def curated_markdown_path?(path, prefixes)
  value = path.to_s.strip
  return false unless value.end_with?(".md")
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")

  prefixes.any? { |prefix| value.start_with?("#{prefix}/") }
end

def safe_relative_path?(path)
  value = path.to_s.strip
  return false if value.empty?
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")
  true
end

def archived_evidence_path?(path)
  safe_relative_path?(path) && path.to_s.start_with?("archive/inbox-reviewed/") && path.to_s.end_with?(".md")
end

def archive_manifest_path(brain, session)
  File.join(brain, "archive", "dreams-session-audits", File.basename(session), "archive-manifest.json")
end

def archive_manifest_entries(brain, session, session_keys)
  path = archive_manifest_path(brain, session)
  return [nil, path, []] unless File.file?(path)

  manifest = JSON.parse(File.read(path))
  errors = []
  errors << "#{repo_relative(path, brain)}: schema must be dreams-archive-manifest.v1" unless manifest["schema"] == "dreams-archive-manifest.v1"
  errors << "#{repo_relative(path, brain)}: session must match review session" unless session_keys.include?(manifest["session"].to_s)
  entries = manifest["entries"]
  unless entries.is_a?(Array)
    errors << "#{repo_relative(path, brain)}: entries must be an array"
    entries = []
  end
  entries_by_source = entries.each_with_object({}) do |entry, memo|
    next unless entry.is_a?(Hash)

    source_path = entry["source_path"].to_s
    memo[source_path] = entry unless source_path.empty?
  end
  [entries_by_source, path, errors]
rescue JSON::ParserError => error
  [nil, path, ["#{repo_relative(path, brain)}: invalid JSON: #{error.message}"]]
end

def timeline_source_refs(value)
  refs = []
  visit = lambda do |node|
    case node
    when Array
      node.each { |item| visit.call(item) }
    when Hash
      %w[source_hash content_hash hash source_ref].each do |key|
        ref = node[key].to_s.strip
        refs << ref unless ref.empty?
      end
      node.each_value { |child| visit.call(child) }
    end
  end
  visit.call(value)
  refs.uniq
end

def timeline_targets(value)
  targets = []
  visit = lambda do |node|
    case node
    when Array
      node.each { |item| visit.call(item) }
    when Hash
      %w[target path page slug].each do |key|
        target = node[key].to_s.strip
        targets << target unless target.empty?
      end
      node.each_value { |child| visit.call(child) }
    end
  end
  visit.call(value)
  targets.uniq
end

def proposal_artifact_path(session, target_path)
  File.join(session, "proposals", "curated", *target_path.to_s.split("/"))
end

def repo_relative(path, brain)
  path.to_s.sub(%r{\A#{Regexp.escape(brain)}/?}, "")
end

def git_output(brain, *args)
  output, status = Open3.capture2e("git", "-C", brain, *args)
  [output, status.success?]
end

def git_head_blob(brain, rel)
  output, ok = git_output(brain, "show", "HEAD:#{rel}")
  ok ? output : nil
end

def git_changed_files(brain)
  output, ok = git_output(brain, "diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--")
  abort "git diff failed in #{brain}: #{output}" unless ok

  output.lines.map(&:strip).reject(&:empty?)
end

def git_untracked_files(brain)
  output, ok = git_output(brain, "ls-files", "--others", "--exclude-standard")
  abort "git ls-files failed in #{brain}: #{output}" unless ok

  output.lines.map(&:strip).reject(&:empty?)
end

def empty_inventory?(inventory_path)
  return false unless File.file?(inventory_path)

  inventory = JSON.parse(File.read(inventory_path))
  drafts = inventory["drafts"]
  total = inventory["total"]
  return false unless drafts.is_a?(Array)
  return false unless total.is_a?(Integer)

  drafts.empty? && total.zero?
rescue JSON::ParserError
  false
end

def finish_empty_session!(brain, session_keys, inventory_path, require_target_diff, curated_prefixes)
  unless empty_inventory?(inventory_path)
    abort "no ledger rows found for non-empty or invalid inventory: #{inventory_path}"
  end

  if require_target_diff
    changed_curated_files = git_changed_files(brain).select { |path| curated_markdown_path?(path, curated_prefixes) }
    untracked_curated_files = git_untracked_files(brain).select { |path| curated_markdown_path?(path, curated_prefixes) }
    if changed_curated_files.any?
      abort "changed curated files missing target_actions: #{changed_curated_files.join(", ")}"
    end
    if untracked_curated_files.any?
      abort "untracked curated files must be staged or removed before validation: #{untracked_curated_files.join(", ")}"
    end
  end

  puts JSON.generate({ ok: true, session: session_keys.first, rows: 0 })
  exit 0
end

def strip_frontmatter(text)
  return nil if text.nil?

  lines = text.lines
  start = 0
  if lines.first&.strip == "---"
    close_offset = lines[1..]&.find_index { |line| line.strip == "---" }
    start = close_offset ? close_offset + 2 : 0
  end
  lines[start..]&.join || ""
end

def body_before_timeline(text)
  body = strip_frontmatter(text)
  return nil if body.nil?

  lines = body.lines
  separator_offset = lines.find_index { |line| line.strip == "---" }
  stop = separator_offset || lines.length
  lines[0...stop].join
end

def semantic_compiled_truth_segment(text)
  body = body_before_timeline(text)
  return nil if body.nil?

  lines = body.lines
  kept = []
  skipping_temporal = false
  lines.each do |line|
    if line.match?(/\A##\s+Temporal Metadata\s*\z/i)
      skipping_temporal = true
      next
    end
    if skipping_temporal && line.match?(/\A##\s+/)
      skipping_temporal = false
    end
    kept << line unless skipping_temporal
  end
  kept.join.strip
end

def timeline_segment(text)
  body = strip_frontmatter(text)
  return nil if body.nil?

  lines = body.lines
  separator_offset = lines.find_index { |line| line.strip == "---" }
  return "" unless separator_offset

  lines[(separator_offset + 1)..].join.strip
end

def row_keys(row, brain)
  row_path_keys(row, brain) + row_hash_keys(row)
end

def row_path_keys(row, brain)
  [
    row["source_path"],
    row["source_snapshot"],
    row["relative_path"],
    row["draft_path"]
  ].compact.flat_map { |value| normalized_keys(value, brain) }.uniq
end

def row_hash_keys(row)
  [
    row["content_hash"],
    row["dedupe_key"],
    row["sha256"]
  ].compact.map { |value| value.to_s.strip }.reject(&:empty?).uniq
end

def draft_keys(draft, brain)
  draft_path_keys(draft, brain) + draft_hash_keys(draft)
end

def draft_path_keys(draft, brain)
  [
    draft["path"],
    draft["relative_path"],
    draft["source_snapshot"]
  ].compact.flat_map { |value| normalized_keys(value, brain) }.uniq
end

def draft_hash_keys(draft)
  [
    draft["content_hash"],
    draft["dedupe_key"],
    draft["sha256"]
  ].compact.map { |value| value.to_s.strip }.reject(&:empty?).uniq
end

def resolve_repo_path(path, brain)
  value = path.to_s
  return value if value.empty? || value.start_with?(File::SEPARATOR)

  File.expand_path(value, brain)
end

def session_owner_report_bindings(session, brain)
  assignments_path = File.join(session, "session-owner", "assignments.json")
  return {} unless File.file?(assignments_path)

  assignments = JSON.parse(File.read(assignments_path))
  Array(assignments["tasks"]).each_with_object({}) do |task, memo|
    session_id = task["session_id"].to_s
    next if session_id.empty?

    report_path = task["report_path"].to_s
    report_file_path = resolve_repo_path(report_path, brain)
    report_sha = File.file?(report_file_path) ? Digest::SHA256.hexdigest(File.read(report_file_path)) : nil
    memo[session_id] = {
      "agent_id" => task["agent_id"].to_s,
      "report_path" => report_path,
      "report_file_path" => report_file_path,
      "report_sha256" => report_sha,
      "expected_review_units" => Array(task["expected_review_units"]).map(&:to_s)
    }
  end
rescue JSON::ParserError
  {}
end

def expected_segment_numbers(draft)
  numbers = draft["segment_numbers"]
  parsed_numbers = if numbers.is_a?(Array)
                     numbers.map { |item| item.to_i }.select(&:positive?).uniq.sort
                   else
                     []
                   end
  return parsed_numbers if parsed_numbers.any?

  count = draft["capture_segment_count"].to_i
  count.positive? ? (1..count).to_a : []
end

def multi_segment_session_draft?(draft)
  return false unless present?(draft["session_id"])

  mode = draft["capture_mode"].to_s
  segment_numbers = expected_segment_numbers(draft)
  (mode == "session" || draft["capture_segment_count"].to_i > 1) && segment_numbers.length > 1
end

def coverage_segment_number(segment)
  return nil unless segment.is_a?(Hash)

  index = segment["segment_index"]
  return index if index.is_a?(Integer) && index.positive?

  id = segment["segment_id"].to_s
  match = id.match(/\Asegment-(\d+)\z/)
  return match[1].to_i if match

  nil
end

def validate_session_owner_binding!(errors, prefix, draft, row, session_owner_reports, brain)
  session_id = draft["session_id"].to_s
  return if session_id.empty?

  expected = session_owner_reports[session_id]
  return unless expected

  binding = row["session_owner_report"]
  unless binding.is_a?(Hash)
    errors << "#{prefix}: session draft row requires session_owner_report binding"
    return
  end

  if binding["session_id"].to_s != session_id
    errors << "#{prefix}: session_owner_report.session_id must match draft session_id"
  end
  if binding["agent_id"].to_s != expected["agent_id"].to_s || binding["agent_id"].to_s.empty?
    errors << "#{prefix}: session_owner_report.agent_id must match assignment"
  end
  binding_report_path = binding["report_path"].to_s
  if binding_report_path.empty? || resolve_repo_path(binding_report_path, brain) != expected["report_file_path"].to_s
    errors << "#{prefix}: session_owner_report.report_path must resolve to assignment report_path"
  end
  if binding["report_sha256"].to_s != expected["report_sha256"].to_s || binding["report_sha256"].to_s.empty?
    errors << "#{prefix}: session_owner_report.report_sha256 must match current report file"
  end
  covered = Array(binding["covered_review_units"]).map(&:to_s)
  expected_units = expected["expected_review_units"]
  missing = expected_units - covered
  extra = covered - expected_units
  errors << "#{prefix}: session_owner_report missing covered review units: #{missing.join(", ")}" if missing.any?
  errors << "#{prefix}: session_owner_report has unexpected covered review units: #{extra.join(", ")}" if extra.any?
end

def validate_session_coverage!(errors, prefix, draft, row, session_owner_reports = {}, brain = nil)
  validate_session_owner_binding!(errors, prefix, draft, row, session_owner_reports, brain)

  parse_errors = Array(draft["segment_parse_errors"]).map(&:to_s).reject(&:empty?)
  if parse_errors.any? && row["preservation_mode"].to_s != "blocked-safety"
    errors << "#{prefix}: inventory draft has capture segment parse errors: #{parse_errors.join("; ")}"
  end
  return unless multi_segment_session_draft?(draft)

  live_hash_keys = [
    draft["dedupe_key"],
    draft["sha256"]
  ].compact.map { |value| value.to_s.strip }.reject(&:empty?).uniq
  if live_hash_keys.any? && (row_hash_keys(row) & live_hash_keys).empty?
    errors << "#{prefix}: multi-segment session row must include live inventory dedupe_key or sha256, not only stale frontmatter content_hash"
  end

  coverage = row["coverage"]
  session_coverage = coverage.is_a?(Hash) ? coverage["session_coverage"] : nil
  unless session_coverage.is_a?(Hash)
    errors << "#{prefix}: multi-segment session draft requires coverage.session_coverage"
    return
  end

  expected_numbers = expected_segment_numbers(draft)
  expected_ids = expected_numbers.map { |number| "segment-#{number}" }
  session_id = draft["session_id"].to_s
  if session_coverage["session_id"].to_s != session_id
    errors << "#{prefix}: coverage.session_coverage.session_id must match inventory session_id"
  end
  if session_coverage["capture_segment_count"].to_i != expected_numbers.length
    errors << "#{prefix}: coverage.session_coverage.capture_segment_count must match inventory segment count"
  end

  review_strategy = session_coverage["review_strategy"].to_s.strip
  if review_strategy.length < 20 || placeholder_text?(review_strategy)
    errors << "#{prefix}: coverage.session_coverage.review_strategy must describe full-session review"
  end
  english_only!(errors, prefix, "coverage.session_coverage.review_strategy", review_strategy)

  segments = session_coverage["segments"]
  unless segments.is_a?(Array)
    errors << "#{prefix}: coverage.session_coverage.segments must list every capture segment"
    segments = []
  end

  actual_numbers = segments.map { |segment| coverage_segment_number(segment) }.compact
  duplicate_numbers = actual_numbers.select { |number| actual_numbers.count(number) > 1 }.uniq
  missing_numbers = expected_numbers - actual_numbers
  extra_numbers = actual_numbers - expected_numbers
  errors << "#{prefix}: coverage.session_coverage has duplicate segments: #{duplicate_numbers.map { |number| "segment-#{number}" }.join(", ")}" if duplicate_numbers.any?
  errors << "#{prefix}: coverage.session_coverage missing segments: #{missing_numbers.map { |number| "segment-#{number}" }.join(", ")}" if missing_numbers.any?
  errors << "#{prefix}: coverage.session_coverage has unexpected segments: #{extra_numbers.map { |number| "segment-#{number}" }.join(", ")}" if extra_numbers.any?

  units = row["memory_units"].is_a?(Array) ? row["memory_units"] : []
  units.each_with_index do |unit, index|
    next unless unit.is_a?(Hash)

    anchor = unit["source_anchor"].to_s
    unless anchor.match?(/\bsegment-\d+\b/i)
      errors << "#{prefix} memory_units[#{index}]: multi-segment session unit source_anchor must include segment-N"
    end
  end

  segments.each_with_index do |segment, index|
    segment_prefix = "#{prefix} coverage.session_coverage.segments[#{index}]"
    unless segment.is_a?(Hash)
      errors << "#{segment_prefix}: must be an object"
      next
    end

    number = coverage_segment_number(segment)
    segment_id = number ? "segment-#{number}" : segment["segment_id"].to_s
    unless expected_ids.include?(segment_id)
      errors << "#{segment_prefix}: segment_id must be one of #{expected_ids.join(", ")}"
    end

    source_anchor = segment["source_anchor"].to_s.strip
    if source_anchor.length < 8 || source_anchor.length > 240 || placeholder_text?(source_anchor)
      errors << "#{segment_prefix}: source_anchor must point to the reviewed capture segment"
    end
    english_only!(errors, segment_prefix, "source_anchor", source_anchor)
    if number && !source_anchor.downcase.include?("segment-#{number}")
      errors << "#{segment_prefix}: source_anchor must include segment-#{number}"
    end

    status = segment["status"].to_s
    unless ALLOWED_SESSION_SEGMENT_STATUSES.include?(status)
      errors << "#{segment_prefix}: status must be #{ALLOWED_SESSION_SEGMENT_STATUSES.join("/")}"
    end

    summary = segment["summary"].to_s.strip
    if summary.length < 20 || placeholder_text?(summary)
      errors << "#{segment_prefix}: summary must describe what this segment contributed or why it was discarded"
    end
    english_only!(errors, segment_prefix, "summary", summary)

    indexes = segment["memory_unit_indexes"]
    unless indexes.is_a?(Array) && indexes.any? && indexes.all? { |item| item.is_a?(Integer) }
      errors << "#{segment_prefix}: memory_unit_indexes must reference audited memory_units"
      next
    end

    indexes.each do |unit_index|
      unit = units[unit_index]
      unless unit.is_a?(Hash)
        errors << "#{segment_prefix}: memory_unit_indexes[#{unit_index}] does not reference a memory unit"
        next
      end
      if number && !unit["source_anchor"].to_s.downcase.include?("segment-#{number}")
        errors << "#{segment_prefix}: memory_units[#{unit_index}].source_anchor must include segment-#{number}"
      end
    end
  end
end

def validate_archive_manifest_entry!(errors, prefix, draft, row, archive_entries_by_source, archive_manifest_file)
  return if row["preservation_mode"].to_s == "blocked-safety"

  expected_sha = draft["sha256"].to_s.strip
  return if expected_sha.empty?

  source_path = row["source_path"].to_s
  archived_path = row["archived_path"].to_s
  if archive_entries_by_source.nil?
    errors << "#{prefix}: archive manifest missing reviewed snapshot proof: #{archive_manifest_file}"
    return
  end

  entry = archive_entries_by_source[source_path]
  unless entry
    errors << "#{prefix}: archive manifest missing entry for #{source_path}"
    return
  end

  if entry["archived_path"].to_s != archived_path
    errors << "#{prefix}: archive manifest archived_path must match ledger row"
  end
  if entry["inventory_sha256"].to_s != expected_sha
    errors << "#{prefix}: archive manifest inventory_sha256 must match inventory sha256"
  end
  if entry["source_snapshot_sha256"].to_s != expected_sha
    errors << "#{prefix}: archive manifest source_snapshot_sha256 must match inventory sha256"
  end
  if entry["archived_pre_redaction_sha256"].to_s != expected_sha
    errors << "#{prefix}: archive manifest archived_pre_redaction_sha256 must prove archive came from reviewed snapshot"
  end
end

unless File.file?(ledger_path)
  finish_empty_session!(brain, session_keys, inventory_path, options[:require_target_diff], curated_prefixes)
end

rows = []
File.foreach(ledger_path).with_index(1) do |line, lineno|
  next if line.strip.empty?
  row = JSON.parse(line)
  next unless session_keys.include?(row["session"].to_s)
  rows << [lineno, row]
rescue JSON::ParserError => error
  abort "invalid JSON at #{ledger_path}:#{lineno}: #{error.message}"
end

if rows.empty?
  finish_empty_session!(brain, session_keys, inventory_path, options[:require_target_diff], curated_prefixes)
end

session_owner_reports = session_owner_report_bindings(session, brain)
errors = []
changed_files = options[:require_target_diff] ? git_changed_files(brain) : []
changed_curated_files = changed_files.select { |path| curated_markdown_path?(path, curated_prefixes) }
untracked_files = options[:require_target_diff] ? git_untracked_files(brain) : []
untracked_curated_files = untracked_files.select { |path| curated_markdown_path?(path, curated_prefixes) }
action_paths_for_session = []
rows.each do |lineno, row|
  prefix = "#{ledger_path}:#{lineno} #{row["source_path"] || row["content_hash"] || "(unknown)"}"
  mode = row["preservation_mode"].to_s
  decision = row["decision"].to_s
  quality_reason = row["quality_reason"].to_s.strip
  targets = row["targets"]
  target_actions = row["target_actions"]
  target_paths = targets.is_a?(Array) ? targets.map(&:to_s) : []
  if target_paths.any?
    duplicate_targets = target_paths.select { |path| target_paths.count(path) > 1 }.uniq
    errors << "#{prefix}: duplicate targets: #{duplicate_targets.join(", ")}" if duplicate_targets.any?
    target_paths.each do |path|
      errors << "#{prefix}: target must be allowlisted curated markdown: #{path}" unless curated_markdown_path?(path, curated_prefixes)
    end
  end

  if options[:require_evidence_drilldown] && mode != "blocked-safety"
    archived_path = row["archived_path"].to_s.strip
    source_excerpt_summary = row["source_excerpt_summary"].to_s.strip
    if !archived_evidence_path?(archived_path)
      errors << "#{prefix}: archived_path must be a repo-relative archive/inbox-reviewed/*.md evidence path"
    elsif !File.file?(File.join(brain, archived_path))
      errors << "#{prefix}: archived_path file is missing: #{archived_path}"
    end
    if source_excerpt_summary.length < 20 || placeholder_text?(source_excerpt_summary)
      errors << "#{prefix}: source_excerpt_summary must summarize the archived source evidence for drilldown"
    end
    english_only!(errors, prefix, "source_excerpt_summary", source_excerpt_summary)

    if %w[preserve-full preserve-substantial synthesize].include?(mode)
      target_timeline_entry = row["target_timeline_entry"] || row["target_timeline_entries"]
      refs = timeline_source_refs(target_timeline_entry)
      if refs.empty?
        errors << "#{prefix}: curated-memory rows require target_timeline_entry with source_hash/content_hash/source_ref"
      elsif (refs & row_hash_keys(row)).empty?
        errors << "#{prefix}: target_timeline_entry refs must match the row source hash identity"
      end
      timeline_target_paths = timeline_targets(target_timeline_entry)
      if timeline_target_paths.any? && (timeline_target_paths & target_paths).empty?
        errors << "#{prefix}: target_timeline_entry target must match row targets"
      end
    end
  end

  errors << "#{prefix}: missing reviewed_at" unless present?(row["reviewed_at"])
  errors << "#{prefix}: missing source path identity" if row_path_keys(row, brain).empty?
  errors << "#{prefix}: missing source hash identity" if row_hash_keys(row).empty?
  errors << "#{prefix}: missing/invalid importance_score" unless score_valid?(row["importance_score"], score_fields)
  unless allowed_modes.include?(mode)
    errors << "#{prefix}: missing/invalid preservation_mode"
  end
  unless allowed_decisions.include?(decision)
    errors << "#{prefix}: missing/invalid decision"
  end
  unless allowed_quality.include?(row["evidence_quality"].to_s)
    errors << "#{prefix}: missing/invalid evidence_quality"
  end
  if quality_reason.length < 12 || generic_quality_reasons.include?(quality_reason.downcase)
    errors << "#{prefix}: missing or too generic quality_reason"
  end
  english_only!(errors, prefix, "quality_reason", quality_reason)

  coverage = row["coverage"]
  coverage_discarded_content = nil
  if !coverage.is_a?(Hash)
    errors << "#{prefix}: missing coverage assessment"
  else
    source_read = coverage["source_read"].to_s
    durable_content = coverage["durable_content"].to_s.strip
    discarded_content = coverage["discarded_content"].to_s.strip
    unsupported_additions = coverage["unsupported_additions"].to_s.strip
    loss_risk = coverage["loss_risk"].to_s

    errors << "#{prefix}: coverage.source_read must prove full source review" unless allowed_coverage_sources.include?(source_read)
    if durable_content.length < 20 || placeholder_text?(durable_content)
      errors << "#{prefix}: coverage.durable_content must distinguish represented durable material"
    end
    english_only!(errors, prefix, "coverage.durable_content", durable_content)
    if discarded_content.downcase == "none"
      coverage_discarded_content = "none"
    elsif discarded_content.length < 12 || placeholder_text?(discarded_content)
      errors << "#{prefix}: coverage.discarded_content must distinguish discarded/noise/duplicate material or be none"
    else
      coverage_discarded_content = discarded_content
    end
    english_only!(errors, prefix, "coverage.discarded_content", discarded_content)
    errors << "#{prefix}: coverage.unsupported_additions must be none" unless unsupported_additions.downcase == "none"
    english_only!(errors, prefix, "coverage.unsupported_additions", unsupported_additions)
    errors << "#{prefix}: coverage.loss_risk must be low/medium/high" unless allowed_loss_risks.include?(loss_risk)
    if loss_risk == "high" && mode != "blocked-safety"
      errors << "#{prefix}: high loss risk must be blocked-safety, not finalized as #{mode}"
    end
  end

  units = row["memory_units"]
  if !units.is_a?(Array) || units.empty?
    errors << "#{prefix}: missing memory_units decomposition"
    units = []
  end

  max_unit_total = 0
  max_unit_rank = 0
  unit_modes = []
  unit_kinds = []
  supporting_unit_targets = Hash.new { |hash, key| hash[key] = [] }
  units.each_with_index do |unit, index|
    unit_prefix = "#{prefix} memory_units[#{index}]"
    unless unit.is_a?(Hash)
      errors << "#{unit_prefix}: must be an object"
      next
    end

    unit_kind = unit["kind"].to_s
    unit_mode = unit["preservation_mode"].to_s
    unit_reason = unit["reason"].to_s.strip
    unit_summary = unit["summary"].to_s.strip
    unit_source_anchor = unit["source_anchor"].to_s.strip
    unit_score = unit["importance_score"]
    unit_target = unit["target"].to_s

    errors << "#{unit_prefix}: missing/invalid kind" unless allowed_unit_kinds.include?(unit_kind)
    errors << "#{unit_prefix}: missing/invalid preservation_mode" unless allowed_modes.include?(unit_mode)
    unit_modes << unit_mode
    unit_kinds << unit_kind
    if unit_summary.length < 20 || placeholder_text?(unit_summary)
      errors << "#{unit_prefix}: missing or too generic summary"
    end
    english_only!(errors, unit_prefix, "summary", unit_summary)
    if unit_source_anchor.length < 8 || unit_source_anchor.length > 240 || placeholder_text?(unit_source_anchor)
      errors << "#{unit_prefix}: source_anchor must be a short sanitized pointer to the source material"
    end
    english_only!(errors, unit_prefix, "source_anchor", unit_source_anchor)
    if unit_reason.length < 12 || generic_quality_reasons.include?(unit_reason.downcase) || placeholder_text?(unit_reason)
      errors << "#{unit_prefix}: missing or too generic reason"
    end
    english_only!(errors, unit_prefix, "reason", unit_reason)
    english_only!(errors, unit_prefix, "anti_summary_reason", unit["anti_summary_reason"]) if present?(unit["anti_summary_reason"])
    errors << "#{unit_prefix}: missing/invalid importance_score" unless score_valid?(unit_score, score_fields)

    if unit_score.is_a?(Hash) && unit_score["total"].is_a?(Integer)
      max_unit_total = [max_unit_total, unit_score["total"]].max
      if unit_score["fidelity"].is_a?(Integer) && unit_score["fidelity"] >= 2
        unless present?(unit["anti_summary_reason"])
          errors << "#{unit_prefix}: fidelity>=2 requires anti_summary_reason"
        end
      end
    end

    max_unit_rank = [max_unit_rank, mode_rank(unit_mode)].max
    if %w[preserve-full preserve-substantial].include?(unit_mode)
      unless present?(unit["anti_summary_reason"])
        errors << "#{unit_prefix}: #{unit_mode} requires anti_summary_reason"
      end
    end
    if %w[preserve-full preserve-substantial synthesize].include?(unit_mode)
      unless present?(unit["target"]) || array_present?(targets)
        errors << "#{unit_prefix}: #{unit_mode} requires target or row targets"
      end
      if !present?(unit_target) && target_paths.length > 1
        errors << "#{unit_prefix}: #{unit_mode} requires explicit target when row has multiple targets"
      end
      if present?(unit_target) && array_present?(targets) && !target_paths.include?(unit_target)
        errors << "#{unit_prefix}: target must also appear in row targets"
      end
      support_path = if present?(unit_target)
                       unit_target
                     elsif target_paths.length == 1
                       target_paths.first
                     end
      supporting_unit_targets[support_path] << index if present?(support_path)
    end
    if score_valid?(unit_score, score_fields)
      recommended_rank = score_recommended_min_rank(unit_score)
      if mode_rank(unit_mode) < recommended_rank && !%w[duplicate blocked-safety].include?(unit_mode)
        errors << "#{unit_prefix}: preservation_mode is weaker than its importance score requires"
      end
    end
  end

  if score_valid?(row["importance_score"], score_fields) && row["importance_score"]["total"] < max_unit_total
    errors << "#{prefix}: row importance_score total is lower than its strongest memory unit"
  end
  if score_valid?(row["importance_score"], score_fields)
    recommended_rank = score_recommended_min_rank(row["importance_score"])
    if mode_rank(mode) < recommended_rank && !%w[duplicate blocked-safety].include?(mode)
      errors << "#{prefix}: preservation_mode is weaker than its importance score requires"
    end
    if mode == "preserve-full" && recommended_rank < 4
      errors << "#{prefix}: preserve-full requires high authorship/fidelity importance"
    elsif mode == "preserve-substantial" && recommended_rank < 3
      errors << "#{prefix}: preserve-substantial requires substantial authorship/fidelity importance"
    elsif mode == "synthesize" && recommended_rank < 2
      errors << "#{prefix}: synthesize requires durable searchable importance"
    end
  end
  if allowed_modes.include?(mode) && mode_rank(mode) < max_unit_rank && !%w[duplicate blocked-safety].include?(mode)
    errors << "#{prefix}: row preservation_mode is weaker than its strongest memory unit"
  end
  if mode == "duplicate" && unit_modes.any? { |unit_mode| !%w[duplicate discard].include?(unit_mode) }
    errors << "#{prefix}: duplicate row cannot hide non-duplicate memory units"
  end
  if mode == "blocked-safety" && !unit_modes.include?("blocked-safety") && !unit_kinds.include?("unsafe")
    errors << "#{prefix}: blocked-safety row must identify an unsafe or blocked unit"
  end
  if mode == "discard" && (unit_kinds & durable_unit_kinds).any?
    errors << "#{prefix}: discard row cannot contain durable memory units"
  end
  has_non_durable_unit = (unit_kinds & non_durable_unit_kinds).any? || unit_modes.any? { |unit_mode| %w[discard duplicate blocked-safety].include?(unit_mode) }
  if coverage_discarded_content == "none" && has_non_durable_unit
    errors << "#{prefix}: coverage.discarded_content=none conflicts with non-durable memory units"
  elsif coverage_discarded_content && coverage_discarded_content != "none" && !has_non_durable_unit
    errors << "#{prefix}: coverage.discarded_content mentions discarded material but no non-durable unit records it"
  end

  case mode
  when "discard"
    errors << "#{prefix}: discard mode must use decision=discarded" unless decision == "discarded"
    errors << "#{prefix}: discard mode must not include targets" if array_present?(targets)
    if target_actions.is_a?(Array) && target_actions.any?
      errors << "#{prefix}: discard mode must not include target_actions"
    end
  when "source-note", "blocked-safety"
    errors << "#{prefix}: #{mode} mode must use decision=#{mode}" unless decision == mode
    errors << "#{prefix}: #{mode} mode must not include targets" if array_present?(targets)
    if target_actions.is_a?(Array) && target_actions.any?
      errors << "#{prefix}: #{mode} mode must not include target_actions"
    end
  when "duplicate"
    errors << "#{prefix}: duplicate mode must use decision=duplicate" unless decision == "duplicate"
    if target_actions.is_a?(Array) && target_actions.any?
      target_actions.each_with_index do |action, index|
        action_prefix = "#{prefix} target_actions[#{index}]"
        unless action.is_a?(Hash)
          errors << "#{action_prefix}: must be an object"
          next
        end
        path = action["path"].to_s
        kind = action["action"].to_s
        errors << "#{action_prefix}: duplicate action must be no-change-duplicate" unless kind == "no-change-duplicate"
        errors << "#{action_prefix}: path must be allowlisted curated markdown" unless curated_markdown_path?(path, curated_prefixes)
        errors << "#{action_prefix}: missing reason" if action["reason"].to_s.strip.length < 12
        english_only!(errors, action_prefix, "reason", action["reason"])
        if array_present?(targets) && present?(path) && !target_paths.include?(path)
          errors << "#{action_prefix}: path must also appear in targets"
        end
      end
    end
  when "preserve-full", "preserve-substantial", "synthesize"
    unless %w[promoted low-confidence-promoted].include?(decision)
      errors << "#{prefix}: #{mode} mode must use promoted or low-confidence-promoted decision"
    end
    errors << "#{prefix}: #{mode} mode requires non-empty targets" unless array_present?(targets)
    if !target_actions.is_a?(Array) || target_actions.empty?
      errors << "#{prefix}: #{mode} mode requires target_actions"
    else
      truth_changing_actions = []
      target_actions.each_with_index do |action, index|
        action_prefix = "#{prefix} target_actions[#{index}]"
        unless action.is_a?(Hash)
          errors << "#{action_prefix}: must be an object"
          next
        end
        path = action["path"].to_s
        kind = action["action"].to_s
        supporting_units = action["supporting_units"]
        action_paths_for_session << path if present?(path)
        truth_changing_actions << kind if %w[create update supersede].include?(kind)
        errors << "#{action_prefix}: missing path" unless present?(path)
        errors << "#{action_prefix}: missing/invalid action" unless allowed_target_actions.include?(kind)
        unless curated_markdown_path?(path, curated_prefixes)
          errors << "#{action_prefix}: path must be allowlisted curated markdown"
        end
        errors << "#{action_prefix}: missing reason" if action["reason"].to_s.strip.length < 12
        english_only!(errors, action_prefix, "reason", action["reason"])
        if kind == "no-change-duplicate"
          errors << "#{action_prefix}: no-change-duplicate is invalid for #{mode} rows"
        end
        if %w[create update supersede].include?(kind) && action["compiled_truth_changed"] != true
          errors << "#{action_prefix}: #{kind} requires compiled_truth_changed=true"
        elsif kind == "append-timeline" && action["compiled_truth_changed"] != false
          errors << "#{action_prefix}: append-timeline requires compiled_truth_changed=false"
        end
        if array_present?(targets) && present?(path) && !target_paths.include?(path)
          errors << "#{action_prefix}: path must also appear in targets"
        end
        if !supporting_units.is_a?(Array) || supporting_units.empty? || !supporting_units.all? { |item| item.is_a?(Integer) }
          errors << "#{action_prefix}: supporting_units must list memory_units indexes"
        else
          supporting_units.each do |unit_index|
            unit = units[unit_index]
            unless unit.is_a?(Hash)
              errors << "#{action_prefix}: supporting_units[#{unit_index}] does not reference a memory unit"
              next
            end
            unit_mode = unit["preservation_mode"].to_s
            unit_target = unit["target"].to_s
            unless %w[preserve-full preserve-substantial synthesize].include?(unit_mode)
              errors << "#{action_prefix}: supporting_units[#{unit_index}] is not a curated memory unit"
            end
            supports_path = unit_target == path || (!present?(unit_target) && target_paths.length == 1 && target_paths.first == path)
            errors << "#{action_prefix}: supporting_units[#{unit_index}] does not support target path" unless supports_path
          end
        end
        if curated_markdown_path?(path, curated_prefixes) && !supporting_unit_targets.key?(path)
          errors << "#{action_prefix}: target action has no supporting curated memory unit"
        end
        if options[:require_proposal_artifacts] && present?(path) && curated_markdown_path?(path, curated_prefixes)
          artifact = proposal_artifact_path(session, path)
          relative_artifact = Pathname.new(artifact).relative_path_from(Pathname.new(session)).to_s rescue artifact
          if !File.file?(artifact)
            errors << "#{action_prefix}: missing proposed final-content artifact: #{relative_artifact}"
          elsif options[:require_proposal_current_match]
            current_path = File.join(brain, path)
            if !File.file?(current_path)
              errors << "#{action_prefix}: current curated target missing for proposal match: #{path}"
            elsif File.read(current_path) != File.read(artifact)
              errors << "#{action_prefix}: proposed final-content artifact does not match current curated target: #{relative_artifact}"
            end
          end
        end
        if options[:require_target_diff] && present?(path) && curated_markdown_path?(path, curated_prefixes)
          current_text = File.file?(File.join(brain, path)) ? File.read(File.join(brain, path)) : nil
          head_text = git_head_blob(brain, path)
          unless changed_files.include?(path)
            errors << "#{action_prefix}: target path is not changed vs HEAD"
          end
          case kind
          when "create"
            errors << "#{action_prefix}: create target already exists in HEAD" unless head_text.nil?
            if semantic_compiled_truth_segment(current_text).to_s.empty?
              errors << "#{action_prefix}: create requires non-empty compiled truth"
            end
          when "update", "supersede"
            if head_text.nil? || current_text.nil?
              errors << "#{action_prefix}: #{kind} requires existing HEAD and current target"
            elsif semantic_compiled_truth_segment(head_text) == semantic_compiled_truth_segment(current_text)
              errors << "#{action_prefix}: #{kind} requires compiled truth diff vs HEAD"
            end
          when "append-timeline"
            if head_text.nil? || current_text.nil?
              errors << "#{action_prefix}: append-timeline requires existing HEAD and current target"
            elsif semantic_compiled_truth_segment(head_text) != semantic_compiled_truth_segment(current_text)
              errors << "#{action_prefix}: append-timeline must not change compiled truth"
            elsif timeline_segment(head_text) == timeline_segment(current_text)
              errors << "#{action_prefix}: append-timeline requires timeline diff vs HEAD"
            end
          end
        end
      end
      action_paths = target_actions.select { |action| action.is_a?(Hash) }.map { |action| action["path"].to_s }
      duplicate_action_paths = action_paths.reject(&:empty?).select { |path| action_paths.count(path) > 1 }.uniq
      if duplicate_action_paths.any?
        errors << "#{prefix}: duplicate target_actions paths: #{duplicate_action_paths.join(", ")}"
      end
      missing_action_targets = target_paths.reject(&:empty?) - action_paths
      if missing_action_targets.any?
        errors << "#{prefix}: target_actions missing targets: #{missing_action_targets.join(", ")}"
      end
      if %w[preserve-full preserve-substantial].include?(mode) && truth_changing_actions.empty?
        errors << "#{prefix}: #{mode} mode requires create/update/supersede target action"
      end
    end
  end
end

if options[:require_target_diff]
  unaccounted = changed_curated_files - action_paths_for_session
  if unaccounted.any?
    errors << "changed curated files missing target_actions: #{unaccounted.join(", ")}"
  end
  if untracked_curated_files.any?
    errors << "untracked curated files must be staged or removed before validation: #{untracked_curated_files.join(", ")}"
  end
end

if File.file?(inventory_path)
  begin
    inventory = JSON.parse(File.read(inventory_path))
    inventory_drafts = inventory.fetch("drafts", [])
    if !inventory_drafts.is_a?(Array)
      errors << "#{inventory_path}: inventory.drafts must be an array"
      inventory_drafts = []
    end
    if !inventory["total"].is_a?(Integer)
      errors << "#{inventory_path}: inventory.total must be an integer"
    elsif inventory["total"] != inventory_drafts.length
      errors << "#{inventory_path}: inventory.total does not match drafts length"
    end

    archive_entries_by_source = nil
    archive_manifest_file = archive_manifest_path(brain, session)
    if options[:require_evidence_drilldown]
      archive_entries_by_source, archive_manifest_file, archive_manifest_errors = archive_manifest_entries(brain, session, session_keys)
      errors.concat(archive_manifest_errors)
    end

    seen_row_paths = Hash.new { |hash, key| hash[key] = [] }
    rows.each do |lineno, row|
      row_path_keys(row, brain).each { |key| seen_row_paths[key] << lineno }
    end
    seen_row_paths.each do |path_key, lines|
      next unless lines.length > 1

      errors << "#{ledger_path}: source path appears in multiple rows: #{path_key} at lines #{lines.join(", ")}"
    end

    matched_row_lines = {}
    inventory_drafts.each do |draft|
      path_keys = draft_path_keys(draft, brain)
      hash_keys = draft_hash_keys(draft)
      matching_rows = rows.select { |_lineno, row| (row_path_keys(row, brain) & path_keys).any? }
      if matching_rows.any?
        matching_rows_with_hash = matching_rows.select { |_lineno, row| (row_hash_keys(row) & hash_keys).any? }
        if matching_rows_with_hash.empty?
          label = draft["relative_path"] || draft["dedupe_key"] || draft["sha256"] || "(unknown draft)"
          errors << "#{inventory_path}: draft path matched but hash did not: #{label}"
        elsif matching_rows_with_hash.length > 1
          label = draft["relative_path"] || draft["dedupe_key"] || draft["sha256"] || "(unknown draft)"
          lines = matching_rows_with_hash.map(&:first)
          errors << "#{inventory_path}: draft matched multiple ledger rows: #{label} at lines #{lines.join(", ")}"
        else
          lineno, row = matching_rows_with_hash.first
          matched_row_lines[lineno] = true
          label = draft["relative_path"] || draft["dedupe_key"] || draft["sha256"] || "(unknown draft)"
          validate_session_coverage!(errors, "#{inventory_path}:#{label}", draft, row, session_owner_reports, brain)
          if options[:require_evidence_drilldown]
            validate_archive_manifest_entry!(
              errors,
              "#{inventory_path}:#{label}",
              draft,
              row,
              archive_entries_by_source,
              archive_manifest_file
            )
          end
        end
        next
      end

      label = draft["relative_path"] || draft["dedupe_key"] || draft["sha256"] || "(unknown draft)"
      errors << "#{inventory_path}: draft not reconciled in ledger: #{label}"
    end

    extra_rows = rows.reject { |lineno, _row| matched_row_lines[lineno] }
    if extra_rows.any?
      labels = extra_rows.map { |lineno, row| "#{lineno}:#{row["source_path"] || row["content_hash"] || "(unknown)"}" }
      errors << "#{ledger_path}: ledger rows not present in inventory: #{labels.join(", ")}"
    end
  rescue JSON::ParserError => error
    errors << "invalid inventory JSON at #{inventory_path}: #{error.message}"
  end
end

if errors.any?
  warn errors.join("\n")
  abort "review ledger quality validation failed"
end

puts JSON.generate({ ok: true, session: session_keys.first, rows: rows.length })
