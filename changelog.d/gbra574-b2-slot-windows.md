**The facts block shows when a moved or changed value stopped being true: conversation facts carry a slot (where someone lives, who employs them, their role), and `query` works out each value's validity window when it reads.**

<!-- behavior-change: conversation_fact_slot_windows_gbra574 -->

### Added
- `gbrain extract-conversation-facts` asks the model for one slot per fact (location, employer or role) and stores it on the fact's ontology columns (`dimension`, `value`, `value_hash`, `dim_status`), on managed and unmanaged brains, with or without a git repository. Other fact extractors keep their prompt byte for byte.
- The `query` facts block (and the temporal fact reserve) shows an older slot value as "valid FROM to UNTIL", ending where the next value starts, when both came from the same conversation page or the newer fact states the change in plain English. Without such a cue, both values stay open and nothing is labelled. A stored end date wins, and only facts the caller can read take part.
- `gbrain extract-conversation-facts --dry-run` prints an estimate of the paid run: segments, input and output tokens, and dollars at the extraction model's price.

### Changed
- The ontology (`ontology_get`, `ontology_propose`, the chronicle conflict check, the dimension census and `gbrain repair ontology-facts`) ignores conversation facts, which are never closed in storage, so an extracted slot never shadows, closes or absorbs an owner's observation. A conversation fact that holds the exact key an ontology observation needs gives up its slot and keeps its text. Ontology observations report exactly as before.
- A re-extraction or a retention purge that keeps a conversation fact as expired history clears its slot, so the slot never blocks the page's next facts.

### For existing brains
- Nothing is re-extracted automatically. Preview with `gbrain extract-conversation-facts --force --dry-run`, then run `gbrain extract-conversation-facts --force` to add slots.
