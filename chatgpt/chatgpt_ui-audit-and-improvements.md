---
title: "UI audit and improvements"
type: guide
created: 2026-05-27
updated: 2026-05-27
source: chatgpt-export
conversation_id: 6a168386-b16c-83e8-b4ef-138bb55c4f82
message_count: 2
tags: [chatgpt, import, code]
---
# UI audit and improvements

> Conversation ID: 6a168386-b16c-83e8-b4ef-138bb55c4f82
> Created: 2026-05-27T05:39:19Z
> Updated: 2026-05-27T05:41:15Z
> Messages: 2

---

## User

audit this and whats wrong with. ui is a mess and needs clean up. lots of ai slop. ignomre the sidebar for this just look at chat. those should be 3 bento cards not 1 giant card and have concise copy one price, user doesnt need the rest. suggest better card layouts and kill the double carding.

output a bullet list of improvements

---

## Assistant

Mr. White — chat-only audit:

- **Make merch output a true 3-card bento grid**
  - Use **3 equal cards in one row on desktop**.
  - Use **2 + 1 layout on tablet**.
  - Use **single-column stacked cards on mobile**.
  - Current output reads like one long generated blob with three embedded cards.

- **Kill the giant container card**
  - The assistant message should contain a short header, then the 3 cards.
  - Avoid wrapping all merch options inside one oversized white/gray message block that visually competes with the cards.

- **Kill double carding**
  - Each merch option should be one visual surface only.
  - Do not put a card inside a card inside the chat bubble.
  - After selection, show a compact confirmation row, not another big “Merch card created” card.

- **Use one visible price**
  - Show only: **$45**
  - Hide **Artist**, **Jovie**, **Floor**, margin math, and fulfillment cost from the user-facing card.
  - Put internal economics in an admin/debug panel, not the chat result.

- **Replace repeated Printful warnings with one global notice**
  - Current repeated warning copy makes every card feel broken.
  - Use one compact banner below the grid:
    - “Draft only. Connect Printful to publish.”
  - Internal language like “fresh provider snapshot” and “unresolved production warnings” should never appear in the normal user UI.

- **Shorten copy aggressively**
  - Current descriptions feel generated and padded.
  - Cap each card at:
    - Product name
    - 1-line descriptor
    - Price
    - CTA
  - Example:
    - **Signal Tee**
    - “Bold black tee with front typography.”
    - **$45**
    - **Save Draft**

- **Remove AI-sounding phrases**
  - Cut phrases like:
    - “real-show uniform”
    - “no fake dates”
    - “premium tee first and artist merch second”
    - “collectible artifact from the artist world”
    - “coded language”
  - These read as synthetic filler.

- **Rename the cards for scannability**
  - Current:
    - “Tim White Signal Tee”
    - “Tim White Object Tee”
    - “Tim White Archive Tee”
  - Better:
    - **Signal Tee**
    - **Object Tee**
    - **Archive Tee**
  - Artist name can appear once in the section header.

- **Clean hierarchy inside each card**
  - Recommended order:
    - Image
    - Badge: “Draft”
    - Title
    - 1-line description
    - Price
    - CTA row
  - Current order has too many competing text elements.

- **Use one primary CTA**
  - Current cards show both **Save** and **Publish**, while publishing is unavailable.
  - Use:
    - Primary: **Save Draft**
    - Secondary: hidden overflow menu or disabled “Publish” with tooltip
  - Do not show a prominent unavailable action.

- **Make “Draft” a small badge**
  - Put it in the image corner or top-right of the card.
  - Current “Draft” text takes up too much vertical attention.

- **Move “Option 1 / 2 / 3” into subtle labels**
  - Use small eyebrow text:
    - Option 1
    - Option 2
    - Option 3
  - Do not let the option label compete with the product name.

- **Standardize image sizing**
  - Images should have identical aspect ratio and dimensions.
  - Recommended: square or 4:5 product mockup.
  - Avoid variable image heights that make the chat feel unstable.

- **Compress vertical spacing**
  - The current layout is too tall for three options.
  - Reduce padding inside each card.
  - Keep each card to roughly 220–300px tall depending on image size.

- **Use a concise section header**
  - Current:
    - “I'll create three merch design options for you right now.”
    - “Merch Options”
    - “Pick 1, 2, or 3. You can also tell me what to change.”
  - Better:
    - **Merch concepts**
    - “Pick one to save or ask for edits.”

- **Avoid duplicated chat titles**
  - The chat area shows “make me merch” multiple times.
  - Keep one conversation title at the top.
  - The assistant response should start with the actual result, not another redundant title.

- **Make selection confirmation minimal**
  - Current:
    - “Select merch option 1 from generation…”
    - “Tim White Signal Tee”
    - “Saved to Library”
    - “Merch card created”
    - “Draft card is now available in Library.”
  - Better:
    - **Saved: Signal Tee**
    - “Draft added to Library.”
    - Button: **Open Library**

- **Hide generation IDs**
  - “generation 6be8d8e0…” is internal/debug information.
  - Users should never see it unless they are in admin/debug mode.

- **Separate user-facing mode from admin mode**
  - Normal users need:
    - Design
    - Name
    - Price
    - Save action
  - Admins may need:
    - Printful status
    - Cost basis
    - Margin split
    - Provider snapshot
    - Warnings
  - These should be visually and logically separated.

- **Suggested card layout**

  ```text
  [Mockup image]

  Draft                         Option 1

  Signal Tee
  Bold black tee with front typography.

  $45

  [Save Draft]
  ```

- **Suggested 3-card section layout**

  ```text
  Merch concepts
  Pick one to save or ask for edits.

  [Signal Tee]   [Object Tee]   [Archive Tee]

  Draft only. Connect Printful to publish.
  ```

- **Main product direction**
  - The UI should feel like a merch picker, not a verbose AI transcript.
  - Cards should be compact, visual, and decision-oriented.
  - Internal operational state should be collapsed, hidden, or moved to admin tooling.


**Topic:** [[chatgpt-clusters/code_review]]
