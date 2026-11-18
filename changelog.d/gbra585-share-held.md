**On a shared brain, a member who shares a fact about another member now waits for the brain owner, and the member it is about can withdraw it.**

### Changed
- A member's `remember` with `share: true` about another member (`people/<member>`) is stored private with a proposal the owner confirms (`gbrain trust confirm tp<N>`) or drops; until then no other member recalls or reads it. The reply says it is held and for whom. Shares about the team's work, about the caller itself, and by the owner are unchanged.
- The member a shared fact is about can forget it; before, only the brain host could.
- A member's `visibility: "world"` about another member is refused without suggesting `share: true`.

<!-- behavior-change: member_share_about_member_held_gst2897 -->
