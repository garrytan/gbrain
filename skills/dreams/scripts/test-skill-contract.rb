#!/usr/bin/env ruby
# Regression tests for Dreams skill-level orchestration instructions.

skill_path = File.expand_path("../SKILL.md", __dir__)
body = File.read(skill_path)

def assert_includes(body, needle, label)
  abort "#{label}: expected SKILL.md to include #{needle.inspect}" unless body.include?(needle)
end

assert_includes(
  body,
  "reasoning effort: xhigh",
  "session-owner subagent launches must require xhigh reasoning"
)

assert_includes(
  body,
  'reasoning_effort: "xhigh"',
  "session-owner subagent launches must set the native Codex effort override"
)

assert_includes(
  body,
  "at most 6 session-owner subagents may be live at once",
  "session-owner launches must be bounded below the live runtime cap"
)

assert_includes(
  body,
  "wait for a report to be written and accepted before opening the next owner",
  "session-owner launches must advance as a rolling wave"
)

puts "Dreams skill orchestration contract regression tests passed"
