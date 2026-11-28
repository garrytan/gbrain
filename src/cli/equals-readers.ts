/**
 * Where the handler on a path reads the `=` form itself, keyed by command or
 * `command sub` (the narrowest key every path under it honors): the token is
 * kept as written. Pinned by test/cli-flag-equals.test.ts against every module
 * that reads an `=` form.
 */
export const EQUALS_READERS: Readonly<Record<string, readonly string[]>> = {
  // beliefs.ts:61 sourceArg runs before the sub branch (beliefs.ts:98) for every subcommand.
  beliefs: ['--source'],
  // beliefs.ts:52 beliefsChangesArgs (also the thin-client route, thin-client-routing.ts:85).
  'beliefs changes': ['--since'],
  // beliefs-replay-purges.ts:14 flag() reads --x v and --x=v.
  'beliefs replay-purges': ['--archived-at', '--purge-mirror', '--from-url-env'],
  // core/consent.ts:126 via consentGateOrExit (book-mirror.ts:431, args :440, effects paid); book-mirror reads no --max-* itself.
  'book-mirror': ['--max-usd', '--max-cost'],
  // cli/commands/bundled-skill.ts:51 reads --asset <p> and --asset=<p>, and refuses an empty value itself.
  'bundled-skill': ['--asset'],
  // capture.ts:96 regex; every other = form is refused by capture's own parser (capture.ts:132).
  capture: ['--request-id', '--expected-revision'],
  // check-resolvable.ts:120 parseFlags.
  'check-resolvable': ['--skills-dir'],
  // code-scope.ts:64 parseFlag (code-callees.ts:46-48, code-callers.ts:58-60, code-def.ts:166-172, code-refs.ts:109-115).
  'code-callees': ['--limit', '--source'],
  'code-callers': ['--limit', '--source'],
  'code-def': ['--limit', '--lang', '--source'],
  'code-refs': ['--limit', '--lang', '--source'],
  // compile-context.ts:74 flagValue (parseCompileFlags :88-115).
  'compile-context': ['--target', '--budget', '--include', '--out', '--source'],
  // core/consent.ts:123 parseConsentFlags via enableConsent (decide.ts:348, effects paid); decide reads no --max-* itself.
  'decide enable': ['--max-usd', '--max-cost'],
  // doctor/budget.ts:68 --tier/--budget-ms; cli/commands/doctor.ts:27 --tier (thin client); --scope is split (parseDoctorScope reads both forms, #7624);
  // doctor/registry.ts:332 --only; check-resolvable.ts:120 --skills-dir via doctor.ts:460; core/consent.ts:130 --expect (remediate-consent.ts:133).
  doctor: ['--tier', '--budget-ms', '--only', '--skills-dir', '--expect'],
  // edge-proposals.ts:81 flag() used only by list (:91,:93); other subs take the first numeric token as the id (:86).
  'edge-proposals list': ['--status', '--limit'],
  // memory-proposals.ts flag() reads list's --source/--limit and deny's --reason in both forms.
  'memory-proposals list': ['--source', '--limit'],
  'memory-proposals deny': ['--reason'],
  // embed.ts:841 parsePaceArgs (--pace bare or =mode); core/consent.ts:126 via embed-consent.ts:129 and held-embedding.ts:234.
  embed: ['--pace', '--pace-max-concurrency', '--max-usd', '--max-cost'],
  // eval-conversation-parser.ts:48-53 (main.ts handleCliOnly's eval conversation-parser branch and eval.ts:106 both reach it).
  'eval conversation-parser': ['--fixtures', '--min-recall'],
  // eval/decide-eval-flags.ts:122 extractDecideEvalFlags via eval-retrieval-quality.ts:38.
  'eval retrieval-quality': ['--decide', '--decide-provider', '--decide-calibration', '--decide-threshold', '--decide-force-on', '--decide-dataset'],
  // eval-takes-quality.ts:82 getFlag; union over run (:148-162) / trend (:200-201) / regress (:212-226); replay reads none.
  'eval takes-quality': ['--limit', '--cycles', '--budget-usd', '--slug-prefix', '--models', '--source', '--rubric-version', '--against', '--threshold'],
  // export.ts:18 option() (:95-99).
  export: ['--dir', '--source', '--type', '--slug-prefix', '--repo'],
  // core/consent.ts:126 via requireEmbedBackfillConsent (features.ts:306, --auto-fix paid fixes only).
  features: ['--max-usd', '--max-cost'],
  // recall.ts:1183-1188 runForget (plain) and forget-purge.ts:44 flagValue (:114-123, purge); --match is purge-only, ignored by plain forget in any form.
  forget: ['--request-id', '--source', '--match'],
  // forget-purge.ts:131 flagValue --reason (runForgetPurge, routed on --purge at recall.ts:1170); plain forget reads only the separate token (recall.ts:1181).
  'forget --purge': ['--reason', '--reason-scan-limit'],
  // frontmatter.ts:356 runValidate.
  'frontmatter validate': ['--path'],
  // frontmatter.ts:667 runAudit.
  'frontmatter audit': ['--source'],
  // frontmatter-install-hook.ts:184.
  'frontmatter install-hook': ['--source'],
  // graph-query.ts:56.
  'graph-query': ['--source'],
  // import.ts:377-395 readSourceFlag (+ :237 keyless refusal).
  import: ['--source', '--source-id'],
  // integrity.ts:857 extractFlag via cmdCheck (:306-307); integrity auto is STRICT.
  'integrity check': ['--limit', '--type'],
  // core/consent.ts:126 via jobs/submit.ts:104 requireEmbedBackfillConsent, :128 requireReindexConsent, :294 authorizePaidSubmit (paid); submit's own parseFlag(--max-usd) (:286) reads only the separate `off`.
  'jobs submit': ['--max-usd', '--max-cost'],
  // jobs/shared.ts:121 parseJobIsolationFlag via jobs/supervisor.ts:165.
  'jobs supervisor': ['--job-isolation'],
  // jobs/shared.ts:121 parseJobIsolationFlag via jobs/work.ts:114.
  'jobs work': ['--job-isolation'],
  // jobs/watch.ts parseRefreshMs reads --refresh-ms N and --refresh-ms=N (#7624).
  'jobs watch': ['--refresh-ms'],
  // lint.ts:929 runLint.
  lint: ['--exclude'],
  // migrate-graduation.ts:97 flagValue (parseGraduationArgs :121-151); graduation-only flags, the legacy copier (migrate-engine.ts) never reads them.
  migrate: ['--url-env', '--trigger-bypass', '--drain-timeout', '--batch-size', '--expect'],
  // models.ts parseSkipProviders, doctor mode only, repeated --skip <provider> or --skip=<provider> (#7624).
  'models doctor': ['--skip'],
  // core/bounded-listing-cli.ts:15 parseListingFlags via orphans.ts:353.
  orphans: ['--limit', '--cursor'],
  // pages-purges.ts:12 flagValue (:21) for purges and unpurge.
  'pages purges': ['--source'],
  'pages unpurge': ['--source'],
  // pages-unsearchable.ts:34 flagValue (:42-52).
  'pages unsearchable': ['--state', '--limit', '--source'],
  // pages-ghosts.ts:24.
  'pages ghosts': ['--source'],
  // pages-status.ts:77 parsePagesStatusArgs.
  'pages status': ['--source'],
  // recall.ts:156-201 parseFlags (--entity both, --source-id=, --question=, --budget-policy= with empty-value refusal).
  recall: ['--entity', '--source-id', '--question', '--budget-policy'],
  // reindex.ts:155-163 normalizeReindexArgs at entry (cli/commands/reindex.ts:12); --max-cost via core/consent.ts:126 (reindex-consent.ts:77).
  reindex: ['--type', '--limit', '--repo', '--workers', '--concurrency', '--max-usd', '--max-cost'],
  // core/consent.ts:126 via reindex-code.ts:503 / reindex-code-delegate.ts:51 (paid); the own --max-cost loop (reindex-code.ts:438) reads only the separate token and :521 takes the consent cap.
  'reindex-code': ['--max-usd', '--max-cost'],
  // core/consent.ts:130 --expect via consentGateOrExit (reinit-pglite.ts:109, plan_hash :119); parseArgs (:213) reads no --expect.
  'reinit-pglite': ['--expect'],
  // resolvers.ts:172 extractFlag via cmdList (:66-67).
  'resolvers list': ['--cost', '--backend'],
  // routing-eval.ts:83 parseFlags.
  'routing-eval': ['--skills-dir'],
  // schema.ts:457 parseFlags; only these subs use the parsed source (:208,:499,:542,:562,:872,:1043,:1080,:1103).
  'schema active': ['--source', '--source-id'],
  'schema detect': ['--source', '--source-id'],
  'schema suggest': ['--source', '--source-id'],
  'schema review-candidates': ['--source', '--source-id'],
  'schema review-orphans': ['--source', '--source-id'],
  'schema stats': ['--source', '--source-id'],
  'schema cardinality-preview': ['--source', '--source-id'],
  'schema sync': ['--source', '--source-id'],
  // schema.ts:765 runLintCmd strips both forms through parseFlags before util.parseArgs.
  'schema lint': ['--source', '--source-id'],
  // schema.ts:1138 runReloadCmd; schema.ts:1004 pickPackName for the pack-authoring subs (remove-* are STRICT, add-type is OWN).
  'schema reload': ['--pack'],
  'schema update-type': ['--pack'],
  'schema add-alias': ['--pack'],
  'schema add-prefix': ['--pack'],
  'schema add-link-type': ['--pack'],
  'schema set-extractable': ['--pack'],
  'schema set-expert-routing': ['--pack'],
  'schema scaffold-extractable': ['--pack'],
  // setup.ts runSetup splits --flag=value for every setup value flag before parseFlags reads them.
  setup: ['--members', '--members-file'],
  // skillify.ts:117 parseScaffoldFlags (:142-160); skillify check reads no = form.
  'skillify scaffold': ['--description', '--triggers', '--writes-to', '--skills-dir'],
  // skillpack.ts:312 cmdStatus, :382 cmdSync, :501 cmdMigrateFence, :547 cmdScrubLegacy, :1210 cmdHarvest, :1281-1287 cmdDiff.
  'skillpack status': ['--workspace'],
  'skillpack sync': ['--workspace'],
  'skillpack migrate-fence': ['--workspace'],
  'skillpack scrub-legacy-fence-rows': ['--workspace'],
  'skillpack harvest': ['--from'],
  'skillpack diff': ['--workspace', '--skills-dir'],
  // skillpack/scaffold.ts:36 lane select + :73 --workspace=; harness lane skillpack/harness.ts:91-158 parseHarnessArgs (:364).
  'skillpack scaffold': ['--workspace', '--harness', '--persona', '--skill', '--dest', '--scope', '--skills'],
  // skillpack/reference.ts:44 harness lane (strict-args.ts:102 makes the non-harness lane STRICT); harness.ts:542; skillpack/update.ts readValue (--update-untouched lane).
  'skillpack reference': ['--harness', '--persona', '--skill', '--dest', '--scope', '--workspace', '--skills'],
  // core/bounded-listing-cli.ts:15 via sources.ts:1213 runStatus (+ :1214 paged regex).
  'sources status': ['--limit', '--cursor'],
  // sources-harden.ts:31 flagVal: runHarden (:83-84), runPull (:150-151). `sources pull --path=` refuses: main.ts takes the database-free route only on the exact token.
  'sources harden': ['--branch', '--pat-file'],
  'sources pull': ['--branch'],
  // status.ts:812 parseDeadlineFlag, :834 parseSectionFlag (runStatus :871-881).
  status: ['--section', '--deadline-ms'],
  // core/bounded-listing-cli.ts:15 via sync/operator.ts:167 holdsListing (+ :173 sized check); the `sync --status` alias (syncOperatorVerb, operator.ts:136) reads as this path.
  'sync status': ['--limit', '--cursor'],
  // trust-claim.ts:65 flagValues (:81, :113).
  'trust claim-sources': ['--source'],
  // core/stable-channel.ts:19 parseChannelArg via upgrade.ts:361.
  upgrade: ['--channel'],
};
