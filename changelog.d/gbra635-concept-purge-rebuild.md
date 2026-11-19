**A concept page hidden because one of its source notes was purged is now rebuilt from its remaining notes, unless anyone wrote something on it.**

### Fixed
- When purging an old note hid a concept that synthesis built from it, the next concept synthesis now deletes the hidden page for good and writes a new one from the notes still in the group. Nothing of the old text reaches the model or stays in the brain. Previously the concept stayed hidden and was never shown again. (#9653)
- A hidden concept stays hidden, and the purge preview says why, when it holds anything synthesis did not write: a new title, extra frontmatter, a timeline, curated sections, a file under another name, facts, takes, tags, attached files or data, hand-made links, an entity identity, a guest mark, or a person's decision on an edge proposal. It also stays hidden when the new page would be readable more widely than the hidden one, or when no synthesis model is set.
- Links from other pages to the concept move to the rebuilt page with all their details kept.
- Brains with no git repository get the same behavior. On brains whose writes go through the write owner, hidden concepts stay hidden for now; their rebuild waits for a later release.
