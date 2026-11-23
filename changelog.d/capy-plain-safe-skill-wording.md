**Bundled skills now ask before they spend money, send a file or schedule a job, stop on a model refusal instead of offering another model, and use placeholder names in their examples.**

### Changed
- A model provider's refusal ends that step: book-mirror, cross-modal-review and the model-routing convention tell the agent to report it, naming the model, and not to rerun it on another model.
- book-mirror works from a book the user owns, and its chapter summaries help the reader decide and remember rather than replace the book. Its EPUB snippet now runs as pasted and reads chapters in the book's own order.
- cold-start and ask-user agree on Google data: gbrain's own connector (`gbrain google setup`), a Google Takeout export, or a credential gateway the host already has. Live sync and embedding are offered as their own yes/no, and the progress snippet writes the file the resume steps read.
- perplexity-research sends only the topic and public facts by default and asks before sending page content; its example keeps the API key off the command line.
- brain-pdf hands back the file and sends it elsewhere only to a recipient the user confirms.
- meeting-ingestion, two-tier-extraction, research-compendium and company-brainify say what paid or scheduled work they start, and ask first.
- Examples use placeholder names, paths and sizes, and leftover provenance tags and test-only notes are gone from skill files.

<!-- behavior-change: refusal_stops_step_gst3583 -->
