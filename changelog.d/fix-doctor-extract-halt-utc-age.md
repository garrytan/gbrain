**Doctor reports extraction halt age using the UTC dates recorded by the extractor.**

### Fixed

- A halt recorded before local midnight can still be from the current UTC day. `gbrain doctor` now labels that day correctly on databases configured for another time zone.

<!-- behavior-change: extract_halt_age_utc_calendar -->
