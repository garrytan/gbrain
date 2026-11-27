**`gbrain setup --serves several` now labels the people on the brain and source the harness actually reads, and the OpenClaw owner-sender guard no longer reports itself in force before the gateway runs it.**

<!-- behavior-change: serves_several_pinned_source_gst4043 -->

### Fixed
- `gbrain setup claude-code` and `codex` with `--serves several` label the people on the host brain even when setup runs from a directory inside a mount, so a `.gbrain-mount` there no longer gets the members, rules and keys instead.
- `--members=<ids>` and `--members-file=<path>` work like the two-argument form in `gbrain setup`.
- A harness pinned to one source (`--source`, `GBRAIN_SOURCE` or a Codex setup receipt) gets its people labelled and its member keys writing in that source, not in `default`. `gbrain access serves several` without `--source` labels the source the CLI resolves (`GBRAIN_SOURCE`, a `.gbrain-source` file, then `sources.default`). A re-run on another source moves the keys an earlier setup minted to write there and keeps their secrets; a key setup did not mint that way is reported as skipped with the `gbrain auth rescope` command that moves it.
- `--shape company` with the harness pinned to the `company` source adds that source before labelling the people in it, instead of failing because it does not exist yet.
- For a bot harness (OpenClaw, Hermes, Grok Bot, Muse), the `unscoped_multi_user_token` fix is now `gbrain config set mcp.stdio_may_act_for <members>`, which setup can't do for that harness and which clears the warning once set. It used to name `gbrain setup <harness> --serves several --members`, which setup refuses there.
- `gbrain setup openclaw` keeps settings another setup saved while it worked: the gateway's own index refresh no longer writes back the state it read before an `--owner-sender` or `--require-owner-sender` run finished.
- `gbrain setup openclaw --require-owner-sender` still prints `skill_resolver_owner_unverified`, saying the guard is saved but not in force, until a logged turn shows the gateway running the plugin code that enforces it.
- A multi-agent `gbrain setup openclaw` run that gives settings but skips an agent that is on (no skill directory, a failed catalog build) ends `skill_resolver_setup_incomplete` and names the agent, instead of exiting 0 while that agent keeps its earlier settings.
- `gbrain doctor` no longer lets an OpenClaw memory audience logged before `openclaw.json` last changed clear `skill_resolver_owner_unverified`.
