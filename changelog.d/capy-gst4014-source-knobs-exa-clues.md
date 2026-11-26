**Sources can opt out of atom extraction, transcript imports can name their real origin, upgrades can hand workers to a container's process manager, and re-enabled dream synthesis can start from a cutoff.**

<!-- behavior-change: source_extract_atoms_off_9888 -->
<!-- behavior-change: dedupe_exa_more_clues -->
<!-- behavior-change: dream_synthesize_since_10267 -->

### Added
- `gbrain sources set-extract-atoms <id> off` keeps one source's pages and transcripts away from provider-based atom extraction while they stay synced and searchable. The cycle, `dream --drain` and the auto-drain skip the source, and `gbrain doctor` counts its pages apart instead of asking you to drain them. Preview with `--dry-run`; on is the default. (#9888, #10236)
- `gbrain transcripts ingest --provider <slug>` records where converted conversations came from (slug folder, page id, harness and source kind) instead of labelling them `claude-export`. Without the flag nothing changes; re-imports with the same provider skip unchanged pages. (#10127)
- `gbrain config set self_upgrade.worker_launcher external` lets `gbrain upgrade` hand a jobs worker to the container's own process manager. The worker drains, the upgrade waits for its replacement on the new build and names the launch command if none appears. (#10291)
- `dream.synthesize.since` (an ISO date or timestamp) turns synthesis back on for transcripts captured from then on only, in the autopilot cycle and the CLI; `gbrain dream --dry-run --json` shows the cutoff and the candidate count first. An invalid value fails the phase instead of opening the backlog. (#10267)
- Opt-in Exa dedupe can now search a person page that has no company or job title by an alternate work field, the name of a bare company website, or the title of one visible company the page links with `works_at`. Queries already sent and cached are unchanged; private pages, contact details, URL paths and page text still never leave the machine. (`gbrain dedupe classes --exa --dry-run` previews it.)
- The Grok Bot guide covers keeping CLI output and exit status intact for JSON, the explicit content argument for writes, and checking a lost write's receipt before retrying. (#9113)

### Fixed
- Date windows on `gbrain dream` (`--date`, `--from`, `--to`) now include undated writeback transcripts by their UTC file modification day instead of dropping every one. (#10267)
- The bundled filing skills and guides now say what to write for `originals/` and `ideas/` under the default pack: `type: concept` with subtype `original` or `idea`, instead of an undeclared `type: original`. (#10381)
- The test-discrimination helper and `bun run audit:contributors` count only tests that ran and failed, so a reverted fix whose test file no longer imports is reported as vacuous (exit 3) rather than as proof the test works. (#10056)
