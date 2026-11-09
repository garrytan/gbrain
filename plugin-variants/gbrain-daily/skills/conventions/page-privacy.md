# Page privacy: write no designation by default

Every page you write carries no `visibility`, no `access` and no `readable_by` unless one of these is true:

- It holds another person's private information shared in confidence (a DM, someone's health or money details),
  or it was written for one shared room and must not reach the others: write `visibility: private`.
- The user asked for this page to be private: write `visibility: private`.
- In a shared brain, only named people may read it: write `readable_by: [<member>, group:<group>]`.

Research, project, ops, people, company and meeting pages and summaries of world pages get nothing.
Never write `access:` or `confidentiality:` on a page: gbrain reads them as private.
Never remove a privacy label you did not set unless the user asks; the bulk path is `gbrain repair private-labels`.

The brain owner's agents (credentials bound to `gbrain access owner`) read private pages; every other remote caller
gets `not_found`. Full definition: `docs/guides/access-designations.md`.
