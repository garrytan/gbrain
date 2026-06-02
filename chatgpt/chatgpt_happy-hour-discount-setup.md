---
title: "Happy Hour Discount Setup"
type: note
created: 2024-07-31
updated: 2024-07-31
source: chatgpt-export
conversation_id: 292b24cc-c56b-4768-90ae-514698683f09
message_count: 2
tags: [chatgpt, import]
---
# Happy Hour Discount Setup

> Conversation ID: 292b24cc-c56b-4768-90ae-514698683f09
> Created: 2024-07-31T00:07:29Z
> Updated: 2024-07-31T00:07:40Z
> Messages: 2

---

## User

Here's a question. We use a Clover point-of-sale system at our bar and I want to do a happy hour special where you get two drinks for the price of one and I would like to set up the point-of-sale system so that during those times when you bring in two drinks it automatically discounts one of them 100% or discounts both of them 50% but it should only register if you have two drinks in the cart or four drinks in the cart and it shouldn't register if there's only one drink or if it's not one of our specialty cocktails. So how can I set that up on a Clover point-of-sales?

---

## Assistant

To set up a happy hour special on your Clover point-of-sale (POS) system where you get two drinks for the price of one, follow these steps:

1. **Log in to Clover Dashboard:**
   - Go to your Clover web dashboard and log in with your credentials.

2. **Create the Happy Hour Discount:**
   - Navigate to the "Inventory" app.
   - Select "Discounts" and create a new discount.
   - Name the discount (e.g., "Happy Hour 2-for-1").
   - Set the discount type to "Amount" and the amount to the price of one drink (or set it to 50% if you prefer that approach).
   - Ensure the discount is set to apply only during the specified happy hour times.

3. **Set Up Discount Conditions:**
   - Create rules for when the discount applies. Use the "Happy Hour 2-for-1" discount only for specific items (your specialty cocktails).
   - Make sure the discount conditions include having two or four drinks in the cart. This can be set up in the "Advanced Rules" section.

4. **Configure Item-Specific Discount:**
   - Go to the "Modifiers" app or section.
   - Create a modifier group (e.g., "Happy Hour Specials") and include the specialty cocktails.
   - Apply the "Happy Hour 2-for-1" discount to this modifier group.

5. **Set Time-Based Discounts:**
   - Go back to the "Inventory" app and select "Happy Hour Specials."
   - Set the time when this discount should be active (e.g., 5 PM to 7 PM).
   - Ensure the system recognizes the specific times for happy hour to automatically apply the discount.

6. **Testing:**
   - Add two or four specialty cocktails to the cart during the specified happy hour time.
   - Verify that the discount is applied correctly (one drink should be 100% discounted or both drinks should be 50% discounted).

7. **Ensure Exclusions:**
   - Confirm that the discount does not apply to single drinks or non-specialty cocktails by testing these scenarios.
   - Adjust the conditions as necessary to ensure it works as intended.

This setup ensures the discount only applies when the criteria (two or four specialty cocktails during happy hour) are met, preventing it from triggering incorrectly. If you need further assistance, Clover’s support team can provide detailed guidance tailored to your specific POS setup.


## See Also
- [[chatgpt/chatgpt_toast-pos-discount-setup]]
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
