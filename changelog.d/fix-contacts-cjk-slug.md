**Google Contacts with Chinese and other non-ASCII names no longer disappear during rendering.**

### Fixed
- Fall back to the existing stable contact-ID path when an eligible contact name normalizes to an empty ASCII slug (#10450). Preserve existing ASCII paths and the no-email/no-phone filter.

<!-- behavior-change: contacts_non_ascii_slug_10450 -->
