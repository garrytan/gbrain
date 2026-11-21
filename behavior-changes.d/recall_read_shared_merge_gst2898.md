---
kind: add
---
recall on a key with the read-shared switch on and a private write source now returns both sets of facts when an entity's facts sit in that write source and in one shared source, each fact labelled with its source_id, and names the pair in merged_sources; it used to return no facts and ambiguous_entity. Every other split between same-named entities in two sources keeps that answer: keys without the switch, keys writing into a shared source, a namesake in a guest source, and two shared namesakes.
