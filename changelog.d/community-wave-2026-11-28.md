**Eleven small fixes reported by outside contributors, covering link typing, fact dates, conversation parsing, search boosts, conversation facts, repair previews, the GitHub webhook, setup, doctor and embedding migrations.**

<!-- behavior-change: source_boost_env_none_9876 -->
<!-- behavior-change: calendar_fields_transcript_9885 -->
<!-- behavior-change: fact_date_reference_9886 -->
<!-- behavior-change: conversation_facts_since_window_9956 -->

### Fixed
- Role words such as founded, invested in and advises no longer type a link to a meeting, an email, a conversation, a source document, a note or an inbox item. Those links stay plain mentions, while people and companies keep the role. Contributed by @Masashi-Ono0611 (#9728, #9727).
- The fact claim-date repair no longer moves a fact onto a date that only names a document the claim cites (a date inside a wiki link, a Markdown link target, or right before a quoted title). Doctor's dated-claim count leaves those facts out too. Contributed by @Kkkkkuro (#9886, #7247).
- A meeting summary whose only clock times are calendar fields (start, end, time or date lines, in English or Chinese) no longer reads as a transcript, so doctor stops counting it as a parser miss. Contributed by @Kkkkkuro (#9885, #4193).
- A bare none entry in GBRAIN_SOURCE_BOOST now drops the built-in source boosts, the same way it already did in search.source_boosts. The brain's own boost entries stay. Contributed by @aidenkt (#9876).
- A conversation-facts run started with --since and stopped early by --segment-limit now keeps the facts it extracted on a page that already had facts, instead of paying for them and dropping them. A window whose page changed during the run still adds nothing and is retried. Contributed by @howardpark (#9956).
- The managed release-held repair preview now refuses a held key the apply would refuse (any key that is not an atom page key), with the same reason, so the printed apply command can succeed. Contributed by @Masashi-Ono0611 (#9845, #9842).
- The GitHub push webhook's source lookup now states the repository index's condition, so Postgres uses the index instead of scanning every source. Contributed by @Kkkkkuro (#10064).
- Setup no longer rewrites an instruction file whose memory block is already current. A current file that links into a read-only folder now passes, and a stale one still fails. Contributed by @javieraldape (#10203, #10096).
- Doctor's source_routing_health no longer warns about the conversation archive's source (or its owner-only twin) while the archive has nothing in it yet. Every other empty source still warns. Contributed by @Masashi-Ono0611 (#10152, #10151).
- An embedding migration whose stored-vector check runs long no longer stops as lease-lost. The lease rows are now locked after that check and right before the schema change or config write, so the heartbeat can refresh the lease while the check runs. Contributed by @JMHendon (#9864).
- The unlinked_facts warning now says to keep running the free conversation relink without --slugs, which takes the next untried pages each time, until a pass reports no pages, and that a real pass records what it tried even when it links nothing. Reported by @cupit01 (#10039).
