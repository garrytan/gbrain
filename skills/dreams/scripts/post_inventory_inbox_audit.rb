# Shared post-inventory inbox audit for Dreams terminal reports.

require "digest"
require "json"
require "pathname"
require "time"

module DreamsPostInventoryInboxAudit
  SKIP_PENDING_DECISIONS = %w[skip-targeted-run].freeze

  COUNT_KEYS = %w[
    current_session_blocked_safety
    previous_blocked_safety
    new_pending_after_inventory
    unledgered_not_in_inventory
    ledgered_nonblocked_left_in_inbox
    inventory_unhandled_left_in_inbox
    dry_run_inventory_left_in_inbox
  ].freeze

  FAILURE_KEYS = %w[
    unledgered_not_in_inventory
    ledgered_nonblocked_left_in_inbox
    inventory_unhandled_left_in_inbox
  ].freeze

  def self.zero_counts
    COUNT_KEYS.each_with_object({}) { |key, memo| memo[key] = 0 }
  end

  def self.empty_paths
    COUNT_KEYS.each_with_object({}) { |key, memo| memo[key] = [] }
  end

  def self.default_audit(inventory_generated_at: nil, checked_at: nil)
    {
      "inventory_generated_at" => inventory_generated_at,
      "checked_at" => checked_at,
      "counts" => zero_counts,
      "paths" => empty_paths
    }
  end

  def self.session_keys(session, brain)
    relative = Pathname.new(session).relative_path_from(Pathname.new(brain)).to_s rescue nil
    [session, relative].compact.uniq
  end

  def self.repo_relative(path, brain)
    path.to_s.sub(%r{\A#{Regexp.escape(brain)}/?}, "")
  end

  def self.current_inbox_drafts(brain)
    Dir.glob(File.join(brain, "inbox", "**", "*.md"))
      .reject { |path| File.basename(path) == "README.md" }
      .sort
  end

  def self.extract_frontmatter_time(text, key)
    match = text.match(/\A---\s*\n.*?^#{Regexp.escape(key)}:\s*(.+?)\s*$.*?\n---\s*\n/m)
    return nil unless match

    Time.parse(match[1].to_s.strip.sub(/\A["']/, "").sub(/["']\z/, ""))
  rescue ArgumentError
    nil
  end

  def self.draft_times(path)
    text = File.read(path, 4096)
    source_time = extract_frontmatter_time(text, "created_at") ||
      extract_frontmatter_time(text, "formed_at")
    file_mtime = File.mtime(path)
    observed_time = [source_time, file_mtime].compact.max

    {
      source_time: source_time,
      file_mtime: file_mtime,
      observed_time: observed_time
    }
  end

  def self.draft_time(path)
    draft_times(path)[:observed_time]
  end

  def self.parse_time(value)
    return nil if value.to_s.strip.empty?

    Time.parse(value.to_s)
  rescue ArgumentError
    nil
  end

  def self.ledger_rows(path)
    return [] unless File.file?(path)

    rows = []
    File.foreach(path) do |line|
      next if line.strip.empty?

      rows << JSON.parse(line)
    rescue JSON::ParserError
      next
    end
    rows
  end

  def self.boundary_pending_ledger_rows(inventory, brain)
    path = inventory["ledger_path"].to_s
    return [] if path.empty?

    expanded = Pathname.new(path).absolute? ? path : File.expand_path(path, brain)
    ledger_rows(expanded).select { |row| SKIP_PENDING_DECISIONS.include?(row["decision"].to_s) }
  end

  def self.audit(brain:, session:, inventory:, ledger_rows:, all_ledger_rows:, timestamp:, dry_run:, ignore_after: nil, pending_ledger_rows: [])
    inventory_drafts_by_path = Array(inventory["drafts"]).each_with_object({}) do |draft, memo|
      path = draft["relative_path"].to_s
      memo[path] = draft if !path.empty?
    end
    inventory_path_set = inventory_drafts_by_path.keys.each_with_object({}) { |path, memo| memo[path] = true }
    session_path_rows = ledger_rows.group_by { |row| row["source_path"].to_s }
    all_path_rows = all_ledger_rows.group_by { |row| row["source_path"].to_s }
    pending_path_rows = pending_ledger_rows
      .select { |row| SKIP_PENDING_DECISIONS.include?(row["decision"].to_s) }
      .group_by { |row| row["source_path"].to_s }
    inventory_generated_at = inventory["generated_at"].to_s
    inventory_time = parse_time(inventory_generated_at)

    audit = default_audit(
      inventory_generated_at: inventory_generated_at.empty? ? nil : inventory_generated_at,
      checked_at: timestamp
    )

    ignore_after_time = ignore_after.is_a?(Time) ? ignore_after : parse_time(ignore_after)

    current_inbox_drafts(brain).each do |path|
      times = draft_times(path)
      time = times[:observed_time]

      relative = repo_relative(path, brain)
      in_inventory = inventory_path_set.key?(relative)
      inventory_draft = inventory_drafts_by_path[relative]
      same_path_changed = inventory_draft && source_changed?(path, inventory_draft)
      pending_for_later = pending_boundary_match?(path, pending_path_rows[relative])
      next if ignore_after_time && time && time > ignore_after_time && (!in_inventory || same_path_changed)

      key = classify_path(
        relative,
        time,
        same_path_changed,
        pending_for_later,
        inventory_path_set,
        session_path_rows,
        all_path_rows,
        inventory_time,
        dry_run
      )
      next unless key

      audit["paths"][key] << relative
    end

    COUNT_KEYS.each do |key|
      audit["paths"][key] = audit["paths"][key].sort
      audit["counts"][key] = audit["paths"][key].length
    end

    audit
  end

  def self.source_changed?(path, inventory_draft)
    expected_sha = inventory_draft["sha256"].to_s.strip
    return false if expected_sha.empty?

    Digest::SHA256.file(path).hexdigest != expected_sha
  rescue Errno::ENOENT
    false
  end

  def self.pending_boundary_match?(path, rows)
    rows = Array(rows)
    return false if rows.empty?

    current_sha = Digest::SHA256.file(path).hexdigest
    rows.any? do |row|
      expected_sha = row["sha256"].to_s
      expected_sha.empty? || expected_sha == current_sha
    end
  rescue Errno::ENOENT
    false
  end

  def self.classify_path(relative, draft_time, same_path_changed, pending_for_later, inventory_path_set, session_path_rows, all_path_rows, inventory_time, dry_run)
    session_rows = Array(session_path_rows[relative])
    all_rows = Array(all_path_rows[relative])
    in_inventory = inventory_path_set.key?(relative)

    if in_inventory
      if same_path_changed && inventory_time && draft_time && draft_time > inventory_time
        return "new_pending_after_inventory"
      end

      return "dry_run_inventory_left_in_inbox" if dry_run
      return "current_session_blocked_safety" if session_rows.any? { |row| row["decision"].to_s == "blocked-safety" }
      return "ledgered_nonblocked_left_in_inbox" if session_rows.any?

      return "inventory_unhandled_left_in_inbox"
    end

    if all_rows.any?
      return "previous_blocked_safety" if all_rows.any? { |row| row["decision"].to_s == "blocked-safety" }

      return "ledgered_nonblocked_left_in_inbox"
    end
    return "new_pending_after_inventory" if pending_for_later

    return "new_pending_after_inventory" if inventory_time && draft_time && draft_time > inventory_time

    "unledgered_not_in_inventory"
  end

  def self.counts_markdown(audit)
    JSON.pretty_generate(audit.fetch("counts"))
  end

  def self.path_list(paths)
    values = Array(paths)
    return "none" if values.empty?

    values.map { |path| "`#{path}`" }.join(", ")
  end

  def self.markdown(audit)
    paths = audit.fetch("paths")
    <<~MARKDOWN
      ## Post-Inventory Inbox Audit

      ```json
      #{counts_markdown(audit)}
      ```

      - Inventory generated at: #{audit["inventory_generated_at"] || "unknown"}
      - Checked at: #{audit["checked_at"] || "unknown"}
      - Current-session blocked-safety drafts left in inbox: #{path_list(paths["current_session_blocked_safety"])}
      - Previous blocked-safety drafts left in inbox: #{path_list(paths["previous_blocked_safety"])}
      - New pending drafts captured after inventory: #{path_list(paths["new_pending_after_inventory"])}
      - Unledgered pre-existing drafts not in inventory: #{path_list(paths["unledgered_not_in_inventory"])}
      - Ledgered nonblocked drafts still in inbox: #{path_list(paths["ledgered_nonblocked_left_in_inbox"])}
      - Inventory drafts without session ledger rows still in inbox: #{path_list(paths["inventory_unhandled_left_in_inbox"])}
      - Dry-run inventory drafts intentionally left in inbox: #{path_list(paths["dry_run_inventory_left_in_inbox"])}
    MARKDOWN
  end

  def self.summary_counts(summary)
    match = summary.match(/^## Post-Inventory Inbox Audit\s*\n.*?```json\s*(\{.*?\})\s*```/m)
    return [nil, "SUMMARY.md ## Post-Inventory Inbox Audit must include a fenced json count block"] unless match

    parsed = JSON.parse(match[1])
    [parsed, nil]
  rescue JSON::ParserError => error
    [nil, "SUMMARY.md post-inventory audit json is invalid: #{error.message}"]
  end

  def self.validate_state_audit(audit)
    return ["state.post_inventory_inbox_audit must be an object"] unless audit.is_a?(Hash)

    errors = []
    counts = audit["counts"]
    paths = audit["paths"]
    errors << "state.post_inventory_inbox_audit.counts must be an object" unless counts.is_a?(Hash)
    errors << "state.post_inventory_inbox_audit.paths must be an object" unless paths.is_a?(Hash)
    return errors if errors.any?

    unless (counts.keys - COUNT_KEYS).empty? && (COUNT_KEYS - counts.keys).empty?
      errors << "state.post_inventory_inbox_audit.counts must use exact allowed buckets"
    end
    unless (paths.keys - COUNT_KEYS).empty? && (COUNT_KEYS - paths.keys).empty?
      errors << "state.post_inventory_inbox_audit.paths must use exact allowed buckets"
    end
    COUNT_KEYS.each do |key|
      unless counts[key].is_a?(Integer) && counts[key] >= 0
        errors << "state.post_inventory_inbox_audit.counts.#{key} must be a non-negative integer"
      end
      unless paths[key].is_a?(Array) && paths[key].all? { |item| item.is_a?(String) }
        errors << "state.post_inventory_inbox_audit.paths.#{key} must be an array of paths"
      end
      if counts[key].is_a?(Integer) && paths[key].is_a?(Array) && counts[key] != paths[key].length
        errors << "state.post_inventory_inbox_audit.counts.#{key} must match paths length"
      end
    end
    FAILURE_KEYS.each do |key|
      errors << "post-inventory inbox audit has unresolved #{key}: #{paths[key].join(", ")}" if Array(paths[key]).any?
    end
    errors
  end
end
