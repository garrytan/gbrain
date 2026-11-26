**Four fixes from outside reports: CJK keyword search, doctor's provenance check, schema suggestions and kept ingest records.**

### Fixed
- CJK keyword search honors quoted phrases and OR the way other languages do: `"회귀 원인을"` matches the phrase as written, and `서울 OR 부산 제주` finds pages with 서울 or with both 부산 and 제주. Building the search for a very long CJK query also no longer stalls. (#10417, @runsmlee)
- A remote `edit_page` keeps a page's first-ingest record (where it came from, how and when it was first stored), so doctor's provenance check no longer flags the page afterwards. (#10330, @Kkkkkuro)
- `gbrain doctor` lists provenance pages that only a person can fix in an ok message, instead of warning about them forever and offering a repair that changes nothing. It still warns while such a page is missing the trust marker its stored tier needs. (#10190; reported by @cupit01, first message fix by @zhangkom)
- `gbrain schema suggest` no longer proposes a new type for folders the active schema pack already types, while folders of untyped notes are still suggested. (#10433, reported by @ikatsura)
