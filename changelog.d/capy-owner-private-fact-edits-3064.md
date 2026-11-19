**A remote put_page now tells the brain owner when it kept private fact rows the content left out or reworded, and points at forget_fact.**

<!-- behavior-change: owner_private_fact_edits_gst3064 -->

### Changed
- A remote put_page still never deletes a page's private Facts rows or rewords their claims, the brain owner's included: a stored private row the content leaves out comes back, and a reworded one is kept beside the new text. When the writer is the owner's own credential, the receipt now carries `private_rows_kept: {count, renumbered, message, fix}` (counts of active rows only), whose `fix` is a read-only `recall` lookup of the facts filed under the page. Members, unbound tokens and any read of the receipt with a room declared get no advisory and no count.
- The owner withdraws or replaces a private claim remotely by naming it: `forget_fact` withdraws it, along with every row of that entity stating the same claim, and a put_page that adds a new `private` row with a different statement adds its replacement. Where `forget_fact` refuses, the local CLI's `gbrain forget <id>` does it. The docs say so under "Remote writes and private fact rows".
