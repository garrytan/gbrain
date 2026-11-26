**Google Contacts person pages now carry the contact's birthday.**

### Added
- The contacts sweep requests `birthdays` from the People API. A contact with a birthday gets `birthday:` in frontmatter (`YYYY-MM-DD`, or `--MM-DD` when Google holds no year) and a `Birthday: March 4, 1990.` sentence in the page body, so "when is Alice's birthday" and "whose birthday is in March" are answered from the person's own page. Contacts without a birthday render exactly as before.
- The People field mask changes, so the first contacts sweep after the upgrade lists every contact again (the existing `contacts_person_fields` re-list).
- Docs: `docs/guides/google-connect.md` ("What a contact page carries"). Tests: `test/google-render.test.ts`, `test/google-clients.test.ts`.
