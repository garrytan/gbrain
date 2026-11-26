**A standing-rule correction only ever changes the fact it names, on the page that fact is on, and a brain host asks before finishing someone else's fact change.**

### Fixed
- A correction saves its replacement fact on the page the old fact is on, whether or not you pass `entity`. A fact on no page refuses an `entity`, and the owner's approval never infers one, so an approval can no longer save a fact on a page the correction did not name.
- A fact is never saved onto a standing rule page, from any caller, including through a retired page that points at one.
- `gbrain correct resume <receipt>` on the brain host asks you to type a code before it finishes a fact change your remote session started, the same way `gbrain rules approve` does.
- A correction stopped after its rule was made active finishes when resumed from another connection, instead of ending `conflicted`.
- An approval interrupted before its correction moved on now finishes on the next read of the receipt.
- A team rule a member proposes is readable by every agent of the brain, as before approval, instead of only by the member who wrote it.

### Changed
- A call made on behalf of a guest is refused (`correct_guest_refused`), and a `scope: me` rule from a connection that acts for no member is refused (`invalid_params`) instead of being saved as the owner's.
- A shared credential acting for different audiences keeps each audience's corrections apart: one audience cannot read or resume another's receipt. The cap of waiting corrections still counts the credential as a whole.
- Only the owner's credential speaking for itself (no audience, no attested person, no subagent or slug fence) makes corrections that apply at once; any other owner-tier call proposes them for approval.
