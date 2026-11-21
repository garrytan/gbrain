---
kind: add
---
A remote put_page from the brain owner's own credential that leaves out or rewords private fact rows now says so in its receipt: `private_rows_kept` gives the counts and a read-only `recall` lookup of the page's fact ids. The rows themselves are kept as before, because a remote put_page never deletes a private row or rewords its claim. To withdraw or replace a claim, `forget_fact` it and add a new row with a different statement. Other writers see no change.
