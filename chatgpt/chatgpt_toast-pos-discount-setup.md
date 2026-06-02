---
title: "Toast POS discount setup"
type: note
created: 2025-10-12
updated: 2025-10-12
source: chatgpt-export
conversation_id: 68eb044d-ae98-832c-93de-4d0aabfad565
message_count: 4
tags: [chatgpt, import, long-form]
---
# Toast POS discount setup

> Conversation ID: 68eb044d-ae98-832c-93de-4d0aabfad565
> Created: 2025-10-12T01:29:24Z
> Updated: 2025-10-12T01:31:37Z
> Messages: 4

---

## User

Hey, is there any way for me and the Toast POS to set at cost for food items so that I can discount them to just the food cost price? Um, or to create a discount code that selectively changes the value of food per item differently, so it's not just a blanket 50% off or $5 off, but it actually sets a different amount for each food to get it down to the cost of the food item. Um, I want to be able to charge my employees for just the actual cost of the food item.

---

## Assistant

Mr. White — yes, you *can* do something close in Toast POS, but there’s no native “set‐to‐cost” discount per item that automatically adjusts each item to its food cost price. What you can do is work with a combination of features and some manual setup. Here are the options and workarounds, and how you might piece them together:

---

## What Toast POS supports (relevant features)

1. **Fixed / Open Amount / Percent Discounts**  
   Toast supports discounts of type Fixed $ Off, Fixed % Off, and “Open” discounts (where the employee enters the amount) citeturn0search12turn0search10turn0search29  
   - You can apply these at **item-level** or **check-level**, or target “specific item / group” discounts. citeturn0search10turn0search29turn0search12  
   - But these are *discounts*, not “set this item to exactly $X.” They subtract a dollar or percent, not override the final price.

2. **Open Price Strategy**  
   Toast has a pricing mode called **Open Price** which allows you (or staff) to manually set the price of a menu item at the time it’s ordered. citeturn0search14turn0search28  
   - If you use Open Price for an item, you could manually enter “the cost” when ringing in.  
   - Downside: this is manual and burdened by error or abuse.

3. **Combo Discounts / Combo Pricing**  
   The “Combo” discount type in Toast allows you to reduce the price of a group of items to a set dollar amount. citeturn0search31turn0search12turn0search29  
   - You could make a combo discount where, e.g., “Item A + Modifier B” combine to a preconfigured lower price. But this tends to be “set price for that combo,” not individually adjusting each item’s price to cost.

4. **Modifier Overrides / Negative Modifiers**  
   For modifiers, Toast allows override of item reference price, and modifiers can even have negative prices to “discount” or remove cost components. citeturn0search3turn0search11turn0search41turn0search27turn0search41turn0search26  
   - You might create a “discount modifier” that subtracts a fixed amount (negative modifier) to bring the net to cost.  
   - But that only works well if your item structure and modifiers are simple and stable.

5. **Auto-apply Discounts**  
   Some discount types can be set to auto-apply based on rules (if an item is present, discount triggers). citeturn0search18turn0search29turn0search12  
   - But auto-apply doesn’t allow per-item cost override; it still uses the discount definitions.

---

## Workaround / Hybrid Approaches to Achieve “Charge Employees Cost”

Given the limitations, here’s how you can approximate what you want:

### Method A: Use Open Price + Permissions / Audit Control

- Configure your food items (or a separate “employee menu”) to use **Open Price** pricing strategy. citeturn0search14turn0search28  
- When your employee buys the food, the cashier enters the cost (your internal “food cost” number).  
- You can restrict who can set the open price (manager level) to prevent abuse.  
- Pros: Flexible, per-item.  
- Cons: Manual entry risk, oversight needed.

### Method B: Separate “Employee” Versions of Items

- Create duplicate menu items (or a duplicate “Employee Menu”) where each item’s price is exactly the food cost (or cost + tiny markup).  
- Hide or restrict that menu so only employees can access it (or via a special discount button).  
- For instance, regular “Burger” costs $10 for customers; “Burger — Employee” costs $3.  
- When an employee orders, ring up via “Employee Burger.”  
- Pros: Clear, safe, auditable.  
- Cons: More menu management, duplication.

### Method C: Use Discount + Negative Modifier Adjustment

- For each food item, calculate its margin (selling price minus cost).  
- Add a **negative modifier** or a “discount modifier” that subtracts exactly that margin, leaving only cost.  
- On employee orders, have that modifier default or prompt for application.  
- Or build an item-level discount (Fixed $ Off) that subtracts the margin for that specific item.  
  - You’d need a separate discount per item (e.g., “Burger Emp Discount — $7 off”) and set it as “Specific item / group.” citeturn0search10turn0search29turn0search12  
- Pros: Automates the discounting to exactly cost.  
- Cons: You must maintain a discount for *every* item and update when cost changes.

### Method D: Use Combo Discount Trick

- Suppose you want “Burger + side + drink” for employee at cost. You could create a combo discount that forces that set to cost.  
- But for single items, combo discount isn't ideal.

---

## What I Recommend (Given Your Goal)

Given your desire to “charge employees just the cost of food” (and presumably control abuse), the **Separate Employee Menu / Duplicate Items** method is the cleanest and safest. It gives you full control, avoids manual entering errors, and is auditable.

If you prefer to avoid duplication, the **negative-modifier / item-level discount** approach is viable, though more tedious to maintain.

If you're comfortable with manual input, **Open Price** is the most flexible, but it requires oversight and restrictions.

---

If you like, I can walk you step-by-step on how to set up any of these in your Toast POS (with screen paths). Which approach would you like me to guide you with — Employee menu, negative modifier, or open price?

---

## User

But if I do the separate employee menu, would it modify the inventory count for the initial item, or would I have two sets of inventory?

---

## Assistant

Excellent question, Mr. White — and it’s an important one.  
Here’s how Toast POS handles inventory in this scenario:

---

## 🔹 Default Behavior: Separate Menu Item = Separate Inventory Link

In Toast, **each menu item is treated independently** unless you deliberately link them to the same inventory recipe or product.  

So by default, if you create:
- **“Burger”** (regular item, $10)  
- **“Burger – Employee”** (discounted/cost version, $3)  

→ Toast will consider them *two separate menu items*, with **separate inventory associations**.  
That means inventory for “Burger” won’t be decremented when “Burger – Employee” is sold — **unless** you configure both items to pull from the *same inventory recipe or product*.

---

## 🔹 How to Link Them Properly (so both deduct the same ingredients)

Here’s how to make sure both items share the same inventory tracking:

1. **Go to:**
   `Toast Web Portal → Products → Inventory → Recipes`

2. **Find or create the recipe** that represents your actual food build, e.g.  
   `Burger Recipe = 1 Patty + 1 Bun + 1 Cheese + 1 Tomato Slice`.

3. **Link both menu items** (“Burger” and “Burger – Employee”) to that same recipe.  
   - In each menu item’s configuration:  
     `Menu → Edit Item → Advanced → Inventory Recipe`  
     Choose the *same* recipe for both.

4. Now when either item sells, Toast decrements from the same inventory pool.  
   - Regular Burger → decrements  
   - Employee Burger → decrements **the same ingredients**  
   ✅ No double-stock, no discrepancies.

---

## 🔹 Notes and Best Practices

- **You still have two PLUs / Menu IDs** — one for sales reporting, but both draw from identical food stock.  
- **Reporting clarity:** You’ll see employee sales tracked separately by menu item, which is good for internal reporting.  
- **Cost tracking:** Toast Inventory can still calculate COGS properly because it knows the same recipe applies.

---

## ✅ Summary

| Scenario | Inventory Impact |
|-----------|------------------|
| Separate Employee Item, different recipe | Two separate inventory counts (not linked) ❌ |
| Separate Employee Item, same recipe linked | Both reduce same stock ✅ |
| Open price same item | Same inventory link (if same item ID) ✅ |
| Discount approach (same item) | Same inventory link ✅ |

---

**Recommendation:**  
If you go with the **Employee Menu method**, just make sure to **link both the employee and regular items to the same inventory recipe**. That gives you clean stock control *and* clear employee purchase tracking.

Would you like me to outline the exact steps in Toast’s back-end to link both items to the same inventory recipe?
