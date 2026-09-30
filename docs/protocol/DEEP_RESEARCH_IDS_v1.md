# Deep-research result IDs v1

`search` and `query` emit a source-qualified `id` on each hit. Pass it unchanged to
`fetch`; do not construct it from the ambient source or the hit's slug alone.
The same protocol applies to CLI and both MCP transports. IDs refer to a page
inside the currently selected brain, not to a database or an immutable revision.

## Wire encoding

The format is `gbrain-page:v1:` followed by unpadded base64url of the UTF-8
bytes of `JSON.stringify([source_id, slug])`. The array has exactly two
strings. Source IDs follow GBrain's canonical source-ID validator; slugs
must already be canonical lowercase valid page slugs. JSON escapes delimiters
inside fields; the decoder never splits the source and slug on a delimiter.

The namespace `gbrain-page:` is reserved. Unknown versions, invalid UTF-8,
invalid JSON, invalid source IDs/slugs, extra fields, padded base64, and
noncanonical encodings fail with `invalid_params`. They never fall back to
legacy lookup. A literal page slug starting with the reserved namespace can
still be addressed through its encoded ID or `get_page`.

IDs are opaque client handles, **not credentials or encrypted metadata**.
Every fetch independently checks the current request's read scope. A remote
caller can fetch a source-qualified ID only inside that scope, including the
transport-resolved local federation when no OAuth grant overrides it. Trusted
local CLI callers may fetch any live source in their selected brain. A removed
grant, missing/archived source, deleted/private page, or nonexistent target
returns the same `page_not_found` envelope without candidate metadata. The
operator's private-page policy still applies independently of source grants.
An ID never falls back to a same-slug page in another source.

## Legacy IDs and renames

Bare slug IDs remain accepted when exactly one readable live page matches in
the current read scope. Aliases are resolved only in their owning source.
More than one readable match returns `ambiguous_id` with no candidate list;
repeat `search` to obtain source-qualified IDs. Hidden, deleted, archived, and
out-of-grant pages do not participate in ambiguity detection. Candidate
selection, ambiguity detection, page contents, tags, and revision share one
database snapshot.

Source-qualified IDs may follow an alias after a rename within that source.
An exact source/slug page takes precedence over a stale alias at the same address.
If that exact page is private or soft-deleted, fetch returns the missing-page
envelope instead of substituting the readable alias target. A rename can still
follow its alias when no exact row remains at the old address.
This strict address rule belongs to `fetch`; native `get_page` retains its
documented alias lookup and `include_deleted` recovery behavior.
`fetch.id` echoes the supplied opaque ID; the citation URL names the current
canonical page. Legacy fetches retain the canonical bare-slug response ID.
Recreating a source/slug can resolve the new page: these are logical page
addresses, not permanent object identities. Use `metadata.revision` when a
particular content revision matters.

## Citations

`fetch.url` is `gbrain://page/<source>/<slug path>`, with the source and each
slug path segment percent-encoded separately. Slashes preserve the page's
hierarchy; question marks, hashes, percent signs, spaces and Unicode remain
data, not URL query/fragment syntax. These are brain-local citations, not
public HTTP links. The fetch operation accepts result IDs, not citation URLs.
