# Shared count contract for dreams terminal session artifacts.

module ReviewDraftsSessionCounts
  ALLOWED_DECISIONS = %w[promoted low-confidence-promoted source-note discarded duplicate blocked-safety].freeze
  ALLOWED_MODES = %w[preserve-full preserve-substantial synthesize source-note discard duplicate blocked-safety].freeze
  ALLOWED_SCORE_BANDS = %w[0-3 4-6 7-10 11+].freeze
  REQUIRED_MODE_FLAGS = %w[dry_run apply sync commit push].freeze

  def self.zero_count_map(keys)
    keys.to_h { |key| [key, 0] }
  end

  def self.score_band(total)
    return nil unless total.is_a?(Integer)

    case total
    when 0..3
      "0-3"
    when 4..6
      "4-6"
    when 7..10
      "7-10"
    when 11..15
      "11+"
    end
  end

  def self.count_map_sum(hash, allowed)
    return nil unless hash.is_a?(Hash)
    return nil unless (hash.keys - allowed).empty?
    return nil unless (allowed - hash.keys).empty?
    return nil unless hash.values.all? { |value| value.is_a?(Integer) && value >= 0 }

    hash.values.sum
  end

  def self.canonical_counts(counts)
    {
      "inventory_total" => counts["inventory_total"],
      "handled_total" => counts["handled_total"],
      "by_decision" => counts["by_decision"],
      "by_preservation_mode" => counts["by_preservation_mode"],
      "score_bands" => counts["score_bands"]
    }
  end

  def self.aggregate_ledger_counts(entries)
    by_decision = zero_count_map(ALLOWED_DECISIONS)
    by_mode = zero_count_map(ALLOWED_MODES)
    by_score = zero_count_map(ALLOWED_SCORE_BANDS)
    errors = []

    entries.each_with_index do |entry, index|
      label, row = ledger_entry(entry, index)
      unless row.is_a?(Hash)
        errors << "ledger row #{label} is not an object"
        next
      end

      decision = row["decision"].to_s
      mode = row["preservation_mode"].to_s
      score = row["importance_score"]
      total = score.is_a?(Hash) ? score["total"] : nil
      band = score_band(total)

      if by_decision.key?(decision)
        by_decision[decision] += 1
      else
        errors << "ledger row #{label} has invalid decision for count aggregation"
      end

      if by_mode.key?(mode)
        by_mode[mode] += 1
      else
        errors << "ledger row #{label} has invalid preservation_mode for count aggregation"
      end

      if by_score.key?(band)
        by_score[band] += 1
      else
        errors << "ledger row #{label} has invalid importance_score.total for count aggregation"
      end
    end

    [{
      "handled_total" => entries.length,
      "by_decision" => by_decision,
      "by_preservation_mode" => by_mode,
      "score_bands" => by_score
    }, errors]
  end

  def self.final_counts(inventory_total, entries)
    counts, errors = aggregate_ledger_counts(entries)
    counts = { "inventory_total" => inventory_total }.merge(counts)
    if entries.length != inventory_total
      errors << "ledger row count #{entries.length} does not equal inventory.total #{inventory_total}"
    end
    [counts, errors]
  end

  def self.ledger_entry(entry, index)
    if entry.is_a?(Array) && entry.length == 2 && entry[1].is_a?(Hash)
      [entry[0], entry[1]]
    else
      [index + 1, entry]
    end
  end
end
