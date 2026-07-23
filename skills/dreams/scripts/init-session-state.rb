#!/usr/bin/env ruby
# Initialize a Dreams session directory and state.json with consistent mode flags.

require "fileutils"
require "json"
require "optparse"
require "time"

options = {
  brain: File.join(Dir.home, "brain"),
  session: nil,
  dry_run: false,
  apply: true,
  sync: true,
  commit: true,
  push: true
}

OptionParser.new do |parser|
  parser.banner = "Usage: init-session-state.rb [--brain PATH] [--session PATH] [--dry-run] [--no-sync] [--no-commit] [--no-push]"
  parser.on("--brain PATH", "Brain repo path") { |value| options[:brain] = value }
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--dry-run", "Create a dry-run session state") { options[:dry_run] = true }
  parser.on("--no-sync", "Disable sync for this run") { options[:sync] = false }
  parser.on("--no-commit", "Disable commit for this run") { options[:commit] = false }
  parser.on("--no-push", "Disable push for this run") { options[:push] = false }
end.parse!

brain = File.expand_path(options[:brain])
abort "brain repo not found: #{brain}" unless Dir.exist?(brain)

if options[:dry_run]
  options[:apply] = false
  options[:sync] = false
  options[:commit] = false
  options[:push] = false
end

session = File.expand_path(options[:session] || File.join(brain, ".dreams", Time.now.strftime("%Y%m%d-%H%M%S")))
state_path = File.join(session, "state.json")

FileUtils.mkdir_p(File.join(session, "sources"))
FileUtils.mkdir_p(File.join(session, "proposals"))
FileUtils.mkdir_p(File.join(session, "reports"))

if File.file?(state_path)
  state = JSON.parse(File.read(state_path))
else
  state = {
    active: true,
    phase: "init",
    mode: {
      dry_run: options[:dry_run],
      apply: options[:apply],
      sync: options[:sync],
      commit: options[:commit],
      push: options[:push]
    },
    created_at: Time.now.iso8601,
    counts: {
      inventory_total: 0,
      handled_total: 0,
      by_decision: {
        promoted: 0,
        "low-confidence-promoted": 0,
        "source-note": 0,
        discarded: 0,
        duplicate: 0,
        "blocked-safety": 0
      },
      by_preservation_mode: {
        "preserve-full": 0,
        "preserve-substantial": 0,
        synthesize: 0,
        "source-note": 0,
        discard: 0,
        duplicate: 0,
        "blocked-safety": 0
      },
      score_bands: {
        "0-3": 0,
        "4-6": 0,
        "7-10": 0,
        "11+": 0
      }
    },
    unresolved_blockers: []
  }
  File.write(state_path, JSON.pretty_generate(state) + "\n")
end

puts JSON.generate({
  ok: true,
  session: session,
  state: state_path,
  mode: state["mode"] || state[:mode]
})
