# reference-pack

The canonical 10/10 reference for a third-party gbrain skillpack. This
pack ships inside gbrain's own repo at `examples/skillpack-reference/`
and doubles as an integration-test fixture (`gbrain skillpack doctor
examples/skillpack-reference --quick` is wired into CI; the score must
stay at 10/10 forever).

If you're authoring a new skillpack: read this tree top to bottom,
then run `gbrain skillpack init <your-name>` to scaffold the same
shape into a new directory.

## Install (illustrative)

Third parties who fork this layout publish to their own GitHub repo,
then users scaffold from there:

```bash
gbrain skillpack scaffold your-user/skillpack-<name>
```

`scaffold` lands the files additively (refuses to overwrite), records
the install in `~/.gbrain/skillpack-state.json` with the pinned commit
SHA, then displays `runbooks/bootstrap.md` (no executor — codex T1).

## What this pack adds to the user's agent

A single skill (`skills/reference-pack/`) that explains the third-party
skillpack contract when the user asks. The skill is illustrative; real
packs add useful behavior (judge a hackathon, score a founder, etc.).

## Tree map

```
examples/skillpack-reference/
├── skillpack.json                  # manifest (cathedral fields declared)
├── skills/
│   └── reference-pack/
│       ├── SKILL.md                # frontmatter + body, agent-readable
│       └── routing-eval.jsonl      # 5 intents pinning trigger -> skill
├── runbooks/
│   └── bootstrap.md                # post-scaffold display (no executor)
├── test/
│   └── example.test.ts             # unit test stub (bun:test)
├── e2e/
│   └── example.e2e.test.ts         # E2E stub, gated on DATABASE_URL
├── evals/
│   └── reference-pack.judge.json   # LLM-judge eval, 3 cases minimum
├── CHANGELOG.md                    # Keep-a-Changelog
├── LICENSE                         # SPDX-matching license text
├── README.md                       # this file
└── .gitignore
```

## Doctor verdict

`gbrain skillpack doctor examples/skillpack-reference --quick` should
always print:

```
★ reference-pack@<version>  10/10  [endorsed]
```

A regression test
(`test/skillpack-init-pack.test.ts:e2e-init-doctor-pack`) pins this
contract: any change that drops the reference pack below 10/10 fails
the build. That's the invariant — gbrain ships its own bar.
