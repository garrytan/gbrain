#!/usr/bin/env ruby
# Regression tests for generated gbrain index allowlist verification.

require "fileutils"
require "rbconfig"
require "tmpdir"

CHECK = File.expand_path("check-index-allowlist.rb", __dir__)

def write_fake_gbrain(path, json)
  File.write(path, <<~SH)
    #!/bin/sh
    printf '%s\\n' '#{json.gsub("'", "'\\\\''")}'
  SH
  FileUtils.chmod("+x", path)
end

Dir.mktmpdir("brain-index-allowlist-test") do |root|
  ok_gbrain = File.join(root, "gbrain-ok")
  bad_gbrain = File.join(root, "gbrain-bad")

  write_fake_gbrain(ok_gbrain, '[{"slug":"projects/example"},{"slug":"originals/thought"}]')
  write_fake_gbrain(bad_gbrain, '[{"slug":"projects/example"},{"slug":"inbox/auto/raw-draft"}]')

  ok = system("ruby", CHECK, "--gbrain", ok_gbrain, out: File::NULL, err: File::NULL)
  abort("allowlist check rejected valid pages") unless ok

  ok = system("ruby", CHECK, "--gbrain", bad_gbrain, out: File::NULL, err: File::NULL)
  abort("allowlist check accepted forbidden pages") if ok

  fallback_home = File.join(root, "home")
  fallback_gbrain = File.join(fallback_home, ".bun", "bin", "gbrain")
  FileUtils.mkdir_p(File.dirname(fallback_gbrain))
  write_fake_gbrain(fallback_gbrain, '[{"slug":"projects/fallback"}]')
  ok = system({ "HOME" => fallback_home, "PATH" => "/usr/bin:/bin", "GBRAIN_BIN" => nil }, RbConfig.ruby, CHECK, out: File::NULL, err: File::NULL)
  abort("allowlist check did not fall back to ~/.bun/bin/gbrain") unless ok
end

puts "check-index-allowlist regression tests passed"
