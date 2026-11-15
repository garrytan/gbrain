**`gbrain extract timeline --source db` no longer fails on a large page with many stored versions on a managed Postgres brain.**

Retraction used to read every stored version of the page in one statement inside the publication transaction. With hundreds of versions that statement ran past the 5 second statement timeout on every retry, so the page's timeline extract failed with `write_interrupted` on every maintenance run. The version scan now runs before the transaction and reads one version at a time. Inside the transaction gbrain only checks that the versions it read are still the page's, with the same text. A row whose versions changed in between stays until the next run. Reported in #9362.

### Fixed
- `gbrain extract timeline --source db` and the maintenance timeline pass no longer time out with `write_interrupted` on a page with hundreds of stored versions (#9362).
