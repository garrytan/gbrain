**The unfenced-facts plan counts facts with no entity in SQL instead of downloading them on every cycle pass.**

### Fixed
- `planUnfencedFacts` runs on every extract_facts pass and fetched every unfenced active fact, claim and context text included. Facts with no `entity_slug` can never be fenced, and on one long-lived hosted brain they were about 98% of the unfenced set (1,258 of 1,281), re-downloaded on every pass. They are now counted with one COUNT query; only rows with an entity slug are fetched. `scanned` and `skipped_no_entity` report the same values as before.
