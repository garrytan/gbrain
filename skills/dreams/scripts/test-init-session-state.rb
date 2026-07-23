#!/usr/bin/env ruby
# Regression tests for Dreams session initialization.

require "fileutils"
require "json"
require "tmpdir"

INIT = File.expand_path("init-session-state.rb", __dir__)

def run_json(*args)
  output = IO.popen(args, &:read)
  abort "command failed: #{args.join(" ")}" unless $?.success?

  JSON.parse(output)
end

def assert(condition, message)
  abort message unless condition
end

Dir.mktmpdir("dreams-init-test") do |root|
  brain = File.join(root, "brain")
  FileUtils.mkdir_p(brain)

  normal = run_json("ruby", INIT, "--brain", brain)
  normal_state = JSON.parse(File.read(normal.fetch("state")))
  assert(File.directory?(File.join(normal.fetch("session"), "sources")), "sources dir missing")
  assert(File.directory?(File.join(normal.fetch("session"), "proposals")), "proposals dir missing")
  assert(File.directory?(File.join(normal.fetch("session"), "reports")), "reports dir missing")
  assert(normal_state["active"] == true, "normal state must be active")
  assert(normal_state["phase"] == "init", "normal state phase must be init")
  assert(normal_state["mode"] == {
    "dry_run" => false,
    "apply" => true,
    "sync" => true,
    "commit" => true,
    "push" => true
  }, "normal mode flags wrong")
  assert(normal_state["created_at"].to_s.match?(/\A\d{4}-\d{2}-\d{2}T/), "created_at must be ISO-like")

  dry_session = File.join(brain, ".dreams", "dry")
  dry = run_json("ruby", INIT, "--brain", brain, "--session", dry_session, "--dry-run")
  dry_state = JSON.parse(File.read(dry.fetch("state")))
  assert(dry_state["mode"] == {
    "dry_run" => true,
    "apply" => false,
    "sync" => false,
    "commit" => false,
    "push" => false
  }, "dry-run mode flags wrong")

  dry_state["phase"] = "custom"
  File.write(dry.fetch("state"), JSON.pretty_generate(dry_state) + "\n")
  rerun = run_json("ruby", INIT, "--brain", brain, "--session", dry_session)
  rerun_state = JSON.parse(File.read(rerun.fetch("state")))
  assert(rerun_state["phase"] == "custom", "existing state must not be overwritten")
end

puts "init-session-state regression tests passed"
