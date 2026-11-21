---
kind: fix
---
An archived source now reads as absent for every API token whose source list names it: get_page by slug, list_pages and every other page read stop returning its pages when the call names no source, as search already did, and gbrain sources restore brings them back for the same token. A token whose write source is archived, or whose every source is, reads nothing and answers unknown_source. gbrain access serves several and adding or enabling a member from the admin page now keep pages archived while the brain was personal to the owner before the member can read them.
