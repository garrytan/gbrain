**recall answers "what do we know about acme-example?" for a member who keeps private notes about it.**

### Changed
- On a key with `--read-shared on` and a private write source, recall (entity, since and question) returns the facts from that source and from one shared source holding the same-named entity, each labelled with its `source_id`, and names the pair in `merged_sources`. Before, it returned no facts and `ambiguous_entity`. Every other namesake split keeps that answer.

<!-- behavior-change: recall_read_shared_merge_gst2898 -->
