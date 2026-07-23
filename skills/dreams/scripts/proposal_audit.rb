# Shared proposal-artifact audit for Dreams terminal reports.

module DreamsProposalAudit
  CURATED_PREFIXES = %w[
    people
    companies
    projects
    decisions
    gotchas
    concepts
    meetings
    originals
  ].freeze

  def self.curated_target?(path)
    parts = path.to_s.split("/")
    parts.length >= 2 && CURATED_PREFIXES.include?(parts.first) && path.to_s.end_with?(".md")
  end

  def self.curated_targets(rows)
    targets = []
    Array(rows).each do |row|
      Array(row["target_actions"]).each do |action|
        path = action.is_a?(Hash) ? action["path"].to_s : ""
        targets << path if curated_target?(path)
      end
    end
    targets.uniq.sort
  end

  def self.proposal_artifact_path(session, target)
    File.join(session, "proposals", "curated", *target.split("/"))
  end

  def self.target_namespace_readmes(brain, targets)
    targets.map { |target| target.split("/").first }
      .compact
      .uniq
      .sort
      .map { |namespace| "#{namespace}/README.md" }
      .select { |relative| File.file?(File.join(brain, relative)) }
  end

  def self.audit(brain:, session:, rows:)
    targets = curated_targets(rows)
    targets_with_artifacts = targets.select { |target| File.file?(proposal_artifact_path(session, target)) }
    missing_artifacts = targets - targets_with_artifacts
    {
      "target_namespace_readmes" => target_namespace_readmes(brain, targets),
      "curated_targets" => targets,
      "proposal_artifact_count" => targets_with_artifacts.length,
      "curated_target_count" => targets.length,
      "missing_proposal_artifacts" => missing_artifacts
    }
  end

  def self.path_list(paths)
    values = Array(paths)
    return "none" if values.empty?

    values.map { |path| "`#{path}`" }.join(", ")
  end

  def self.markdown(audit)
    <<~MARKDOWN
      ## Proposal Audit

      - Target namespace READMEs read: #{path_list(audit.fetch("target_namespace_readmes"))}
      - Curated targets with proposed final-content artifacts: #{audit.fetch("proposal_artifact_count")}/#{audit.fetch("curated_target_count")}
      - Curated edits without proposal artifact: #{path_list(audit.fetch("missing_proposal_artifacts"))}
    MARKDOWN
  end

  def self.markdown_section(text)
    lines = text.lines
    start = lines.find_index { |line| line.strip == "## Proposal Audit" }
    return nil unless start

    collected = []
    lines[(start + 1)..].to_a.each do |line|
      break if line.match?(/\A##\s+/)

      collected << line
    end
    collected.join
  end

  def self.validate_summary(summary, audit)
    section = markdown_section(summary)
    return ["SUMMARY.md missing proposal audit section"] unless section

    errors = []
    readmes_line = section.lines.find { |line| line.include?("Target namespace READMEs read:") }
    coverage_line = section.lines.find { |line| line.include?("Curated targets with proposed final-content artifacts:") }
    missing_line = section.lines.find { |line| line.include?("Curated edits without proposal artifact:") }

    errors << "SUMMARY.md proposal audit must list target namespace READMEs read" unless readmes_line
    errors << "SUMMARY.md proposal audit must list proposed final-content artifact coverage" unless coverage_line
    errors << "SUMMARY.md proposal audit must list curated edits without proposal artifacts" unless missing_line
    return errors if errors.any?

    expected_readmes = path_list(audit.fetch("target_namespace_readmes"))
    expected_coverage = "#{audit.fetch("proposal_artifact_count")}/#{audit.fetch("curated_target_count")}"
    expected_missing = path_list(audit.fetch("missing_proposal_artifacts"))

    readmes_value = readmes_line.split(":", 2)[1].to_s.strip
    coverage_value = coverage_line.split(":", 2)[1].to_s.strip
    missing_value = missing_line.split(":", 2)[1].to_s.strip

    unless readmes_value == expected_readmes
      errors << "SUMMARY.md proposal audit target namespace README list must match curated targets"
    end
    unless coverage_value == expected_coverage
      errors << "SUMMARY.md proposal audit artifact coverage must match proposal mirrors"
    end
    unless missing_value == expected_missing
      errors << "SUMMARY.md proposal audit missing-artifact list must match proposal mirrors"
    end
    if audit.fetch("missing_proposal_artifacts").any?
      errors << "SUMMARY.md proposal audit has curated edits without proposal artifacts"
    end

    errors
  end
end
