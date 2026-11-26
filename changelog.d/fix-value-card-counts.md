### Fixed
- `gbrain value` counts a recall once when it falls back to a question recall on a brain without embeddings; it used to count it twice.
- Facts whose page was deleted no longer count as active facts on the card.
- A page whose kind is the literal word `__proto__` is no longer dropped from the card's page breakdown and total.
- The value card guide now says the Nightly items row reads "at least N" when its read reaches the 100-item limit.
