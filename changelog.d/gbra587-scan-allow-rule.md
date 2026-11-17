**A `.gbrain-scan-allow` line can now allow one secret-scan rule in matching files, instead of skipping every rule there.**

<!-- behavior-change: scan_allow_rule_entry -->

### Added
- `.gbrain-scan-allow` accepts `path:<glob> pattern:<rule>`, which allows only the named rule (for example `jwt` on newsletter unsubscribe links) in the files the glob matches; every other rule still blocks a push there. Path globs and fingerprints keep their meaning. A malformed rule line or an unknown rule name allows nothing and is named by the push refusal, `gbrain git scan` and bootstrap verify, and `gbrain git scan` lists each hit a rule line allowed with the line that allowed it (`allowed[]`, `allowlist_problems[]` in `--json`).
