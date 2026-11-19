---
kind: fix
---
A transcript import now gives a new page a title of at most 200 characters, cut with an ellipsis, instead of the whole title the harness reported, which for some harnesses is the session's opening text and could run to over 100 KB. Sessions already imported keep their titles, and the full text stays in the page body. Separately, page titles of any length can now be saved and upgraded: the exact-title lookup index is a hash index, so a brain holding titles over about 2,700 bytes no longer stops its upgrade and no longer refuses those page saves (#9779).
