#!/usr/bin/env ruby
# Record the subagent identity assigned to a Dreams session-owner task.

require "json"
require "digest"
require "optparse"
require "time"

options = {
  session: nil,
  session_id: nil,
  agent_id: nil
}

OptionParser.new do |parser|
  parser.banner = "Usage: record-session-owner-assignment.rb --session PATH --session-id ID --agent-id ID"
  parser.on("--session PATH", "Dreams review session path") { |value| options[:session] = value }
  parser.on("--session-id ID", "Stop-hook session id") { |value| options[:session_id] = value }
  parser.on("--agent-id ID", "Spawned subagent id") { |value| options[:agent_id] = value }
end.parse!

abort "--session is required" if options[:session].to_s.empty?
abort "--session-id is required" if options[:session_id].to_s.strip.empty?
abort "--agent-id is required" if options[:agent_id].to_s.strip.empty?

session = File.expand_path(options[:session])
assignments_path = File.join(session, "session-owner", "assignments.json")
abort "assignments not found: #{assignments_path}" unless File.file?(assignments_path)

TASK_MUTABLE_KEYS = %w[agent_id assigned_at assignment_status task_sha256 prompt_sha256 assignment_event_sha256].freeze

def canonical_task_sha(task)
  stable = task.reject { |key, _value| TASK_MUTABLE_KEYS.include?(key.to_s) }
  Digest::SHA256.hexdigest(JSON.pretty_generate(stable) + "\n")
end

manifest = JSON.parse(File.read(assignments_path))
tasks = Array(manifest["tasks"])
task = tasks.find { |item| item["session_id"].to_s == options[:session_id].to_s }
abort "session-owner task not found for session_id=#{options[:session_id]}" unless task

task_sha = canonical_task_sha(task)
prompt_sha = File.file?(task["prompt_path"].to_s) ? Digest::SHA256.hexdigest(File.read(task["prompt_path"])) : nil
task["agent_id"] = options[:agent_id].to_s
task["assigned_at"] = Time.now.iso8601
task["assignment_status"] = "assigned"
task["task_sha256"] = task_sha
task["prompt_sha256"] = prompt_sha
task["assignment_event_sha256"] = Digest::SHA256.hexdigest([
  task["session_id"],
  task["agent_id"],
  task["assigned_at"],
  task["task_sha256"],
  task["prompt_sha256"]
].join("\n"))

File.write(assignments_path, JSON.pretty_generate(manifest) + "\n")
File.write(task["task_path"], JSON.pretty_generate(task) + "\n") if task["task_path"].to_s != "" && File.file?(task["task_path"])

puts JSON.generate({
  ok: true,
  session: session,
  session_id: task["session_id"],
  agent_id: task["agent_id"],
  assignments: assignments_path
})
