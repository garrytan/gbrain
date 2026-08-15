<!-- A/B EVAL FIXTURE — synthetic resolver shape, do not invoke from agent context. -->
<!-- Variant: YAML-COMPRESSED — functional-areas with non-routing overhead stripped and
     dispatcher entries in compact YAML-map form. Target: 13KB → 9KB at ≥90% held-out accuracy.
     The (dispatcher for: ...) clause is preserved — it is the load-bearing routing signal. -->

# Skill Resolver

Route by area, then drill into the dispatcher list for the most-specific sub-skill.

## Functional Areas

- **Brain & knowledge**: brain pages, enrich, search, export, filing, citations, publishing, book analysis, strategic reading, concept synthesis, archive mining, conversation history, reports, summaries → `brain-ops` (dispatcher for: enrich, query, brain-pdf, brain-publish, brain-export, brain-plan, brain-librarian, brain-commit, brain-storage, brain-storage-links, citation-fixer, repo-architecture, book-mirror, book-mirror-extreme, book-mirror-synthesis, strategic-reading, concept-synthesis, archive-crawler, conversation-history, conversation-enrichment, garry-voice, essay-review, fact-check, takes-extraction, gbrain, gbrain-upgrade, benchmark-gbrain, freshness-monitor, dropbox-archive-review, bulk-skillify, x-handle-enrich, person-score, reports)
- **Content ingestion**: ingest links, articles, PDFs, video, audio, tweets, books, meetings, voice notes, transcription, media enrichment → `ingest` (dispatcher for: media-ingest, meeting-ingestion, meeting-digest, meeting-gold-standard, meeting-signal-pass, voice-note-ingest, article-enrichment, post-ingestion-enrichment, media-enrichment, book-acquisition, annas-archive, pdf-ingest, tweet-deep-ingest, substack-ingest, pocket-ingest, investor-update-ingest, yc-ingest, yc-oh-ingest, yc-app-ingest, yc-meeting-ingest, kindle-library, therapy-ingest, transcript-save, file-archive-ingestion, idea-ingest)
- **Calendar & scheduling**: schedule, events, conflicts, sync, prep, travel booking, time, location → `google-calendar` (dispatcher for: calendar-event-create, calendar-check, calendar-sync, calendar-recall, calendar-travel-setup, meeting-prep, interview-prep, context-now, jet-lag, location-inference)
- **Email & comms**: inbox triage, email search, email send, iMessage, Slack, unsubscribe, Front API → `executive-assistant` (dispatcher for: gmail, email-triage, email-unsubscribe, cold-email-lookup, cold-pitch-scorer, front-api, slack, intro-reping, startup-intro, investigate-no-response)
- **Research & investigation**: web research, people lookup, company lookup, LinkedIn, competitive intel, background checks → `perplexity-research` (dispatcher for: exa, happenstance, crustdata, captain-api, data-research, diligence, company-oppo, network-intel, private-investigator, oppo-research, academic-verify)
- **X/Twitter & social**: tweets, social monitoring, adversary tracking, content strategy, DM triage → `x-ingest` (dispatcher for: adversary-tracking, social-radar, x-daily-quality, x-concept-tier, social-json-store, detect-astroturf, real-name-hostiles, investigate-x-anon, anti-dunk, clapback, tweet-draft, tweet-composition, tweet-shield, journo-dunk, hater-tracker, message-intel, yc-media-monitor, yc-competitor-oppo, yc-booster-tracker, steph-instagram, content-ideas)
- **Places & travel**: checkins, restaurants, showtimes, trip logistics → `checkin` (dispatcher for: trip-logistics, trip-ingest, showtimes, personal-logistics)
- **Product & building**: CEO review, code, debugging, skill creation, testing, refactoring, PR management → `acp-coding` (dispatcher for: gstack-openclaw-ceo-review, gstack-openclaw-investigate, gstack-openclaw-office-hours, gstack-openclaw-retro, skill-creator, skillify, testing, durable-service, refactor, narrative, budget-roi, fail-improve-loop, weekly-essay, printing-press, cross-modal-review, cross-modal-eval)
- **Infrastructure**: tunnels, containers, services, crons, recurring jobs, GitHub, browser automation, security, database migration → `healthcheck` (dispatcher for: ngrok-verify, system-load, container-restart, zombie-reaper, scratch-space, clawvisor, clawvisor-shield, recurring-jobs, github-repo, github-agents, gbrain-pr, captcha-solver, qr-code, browser, browser-use, gstack-browse, binary-deps, pixel-match, nordvpn-proxy, channel-discovery, durable-service, data-loss-gate, public-repo-guard, web-archive, security-audit, cron-scheduler, migrate)
- **People & contacts**: Google contacts, face detection, identification, people enrichment → `google-contacts` (dispatcher for: face-detect, identify-faces, enrich)
- **Tasks & logistics**: daily tasks, reminders, briefings, business dev, flight tracking, voice calls → `daily-task-manager` (dispatcher for: daily-task-prep, business-development, flight-tracker, voice-agent, voice-session-ingest, venus-post-call, voice-link, voice-call-enrich, quo, checkin)
- **Political**: donation tracking, voter guides, civic intel → `political-donations` (dispatcher for: voter-guide, voter-guide-extract, fiscal-forensics)
- **Inter-agent**: Neuromancer delegation, agent coordination → `inter-agent-coordination` (dispatcher for: neuromancer-coordination)
- **Circleback**: meeting search → `circleback-cli`

**Internal data-source skills** (called by other skills, not directly): captain-api, crustdata, exa, happenstance, gmail, google-calendar, google-contacts, slack, clawvisor
