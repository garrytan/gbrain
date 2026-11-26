**Skill and convention files now say which layer handles a refused request, and no longer carry private names, unreproducible figures or guesses about who someone is.**

### Changed
- `skills/conventions/model-routing.md` and the agent operator protocol now say that a configured `chat_fallback_chain` sends a refused request to the next model only when `chat_fallback_on_refusal` is true, and that the agent's own stop-on-refusal rule covers only the models it picks itself. `gbrain doctor --only chat_fallback_chain` shows both settings.
- `skills/meeting-ingestion` keeps an unverified attendee name only on an exact `gbrain whois` match; otherwise it asks the user or removes the name. `skills/cold-start` says nothing is enriched until the user asks.
- Generic placeholders replace named vendors, companies and folders in `skills/conventions/brain-first.md`; an unreproducible eval figure, a follower-count example and leftover notes about where skill text came from are gone.
