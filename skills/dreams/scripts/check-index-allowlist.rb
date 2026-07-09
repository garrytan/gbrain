#!/usr/bin/env ruby
# Verify the generated gbrain index exposes only reviewed curated page slugs.

require "json"
require "open3"
require "optparse"

options = {
  gbrain: ENV["GBRAIN_BIN"] || "gbrain",
  limit: 100_000
}

OptionParser.new do |parser|
  parser.banner = "Usage: check-index-allowlist.rb [--gbrain PATH] [--limit N]"
  parser.on("--gbrain PATH", "gbrain executable path") { |value| options[:gbrain] = value }
  parser.on("--limit N", Integer, "Maximum pages to request") { |value| options[:limit] = value }
end.parse!

allowed_prefixes = %w[
  people companies projects decisions gotchas concepts meetings originals
].freeze

def allowed_slug?(slug, prefixes)
  value = slug.to_s.strip
  return false if value.empty?
  return false if value.start_with?("/")
  return false if value.split("/").include?("..")

  prefixes.any? { |prefix| value.start_with?("#{prefix}/") }
end

def resolve_gbrain(candidate)
  expanded = File.expand_path(candidate)
  return expanded if candidate.include?("/") && File.executable?(expanded)
  return candidate if candidate.include?("/")

  ENV.fetch("PATH", "").split(File::PATH_SEPARATOR).each do |dir|
    path = File.join(dir, candidate)
    return path if File.executable?(path)
  end

  bun_gbrain = File.expand_path("~/.bun/bin/gbrain")
  return bun_gbrain if File.executable?(bun_gbrain)

  candidate
end

request = JSON.generate({ limit: options[:limit] })
stdout, stderr, status = Open3.capture3(resolve_gbrain(options[:gbrain]), "call", "list_pages", request)
unless status.success?
  abort "gbrain list_pages failed: #{stderr.empty? ? stdout : stderr}"
end

pages = JSON.parse(stdout)
abort "gbrain list_pages did not return an array" unless pages.is_a?(Array)

forbidden = pages.reject { |page| allowed_slug?(page["slug"], allowed_prefixes) }
if forbidden.any?
  warn JSON.pretty_generate({ forbidden: forbidden.map { |page| page["slug"] } })
  abort "gbrain index contains non-allowlisted pages"
end

puts JSON.generate({ ok: true, checked: pages.length })
