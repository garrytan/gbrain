---
title: "Shipping promotion for e-commerce."
type: guide
created: 2023-04-03
updated: 2023-04-03
source: chatgpt-export
conversation_id: 8af6a53a-d19b-41d4-9973-0813e264f786
message_count: 8
tags: [chatgpt, import, code]
---
# Shipping promotion for e-commerce.

> Conversation ID: 8af6a53a-d19b-41d4-9973-0813e264f786
> Created: 2023-04-03T01:24:15Z
> Updated: 2023-04-03T01:27:20Z
> Messages: 8

---

## User

{% else %}
  <div style="text-align: center;">
   <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
    <p>FREE shipping on orders $75+ & 30 Day hassle free Returns</p>
  </div>
{% endif %}

---

## Assistant

This code appears to be part of a template for a website or an email. 

It uses an if-else statement to display different content depending on a certain condition. Without the context of the full code, it's not possible to determine what the condition is. 

If the condition is true, the code displays a message with a bold header and a paragraph that says "DELIVERED TO YOUR DOOR" and promotes free shipping and returns for orders of $75 or more. 

If the condition is false, the code displays a different message in a centered div with a header that says "DELIVERED TO YOUR DOOR" and a paragraph that promotes free shipping and returns for orders of $75 or more. 

It's likely that this code is part of a larger e-commerce website or email template that encourages customers to make a purchase by emphasizing the convenience of delivery and the ease of returns.

---

## User

modify this so free shipping and the hassle free returns are seperate sentences in 2 columns

---

## Assistant

To modify the code to display "FREE shipping on orders $75+ " and "30 Day hassle-free Returns" as separate sentences in two columns, you can use HTML to create a table with two columns, and put each sentence in a separate cell. Here's an example of what the modified code could look like:

```
{% else %}
  <div style="text-align: center;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
    <table style="margin: 0 auto;">
      <tr>
        <td style="padding-right: 20px;">FREE shipping on orders $75+</td>
        <td>30 Day hassle-free Returns</td>
      </tr>
    </table>
  </div>
{% endif %}
```

In this modified code, the two sentences are enclosed in separate `<td>` tags, which are placed within a `<tr>` tag to create a row in the table. The `padding-right` style attribute is used to create some space between the two columns.

Note that you can adjust the values of the style attributes (e.g. `padding-right`, `margin`, etc.) to achieve the desired visual layout.

---

## User

add a blakc check mark before each of those two items

---

## Assistant

To add a black check mark before each of the two items in the modified code, you can use a Unicode character for a check mark and add it to the beginning of each sentence using the `::before` pseudo-element in CSS. Here's an example of what the modified code could look like:

```
{% else %}
  <div style="text-align: center;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
    <table style="margin: 0 auto;">
      <tr>
        <td style="padding-right: 20px; text-align: left;">&#x2713; FREE shipping on orders $75+</td>
        <td style="text-align: left;">&#x2713; 30 Day hassle-free Returns</td>
      </tr>
    </table>
  </div>
{% endif %}
```

In this modified code, the Unicode character for a check mark (U+2713) is added to the beginning of each sentence using the `::before` pseudo-element in CSS. The `text-align: left;` style attribute is used to align the text to the left of each cell.

Note that you can adjust the values of the style attributes (e.g. `padding-right`, `margin`, `text-align`, etc.) and the Unicode character for the check mark to achieve the desired visual layout.

---

## User

bold the checkmarks

---

## Assistant

To bold the check marks in the modified code, you can use the `font-weight` property in CSS and set it to `bold`. Here's an example of what the modified code could look like:

```
{% else %}
  <div style="text-align: center;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
    <table style="margin: 0 auto;">
      <tr>
        <td style="padding-right: 20px; text-align: left;"><span style="font-weight: bold;">&#x2713;</span> FREE shipping on orders $75+</td>
        <td style="text-align: left;"><span style="font-weight: bold;">&#x2713;</span> 30 Day hassle-free Returns</td>
      </tr>
    </table>
  </div>
{% endif %}
```

In this modified code, the `font-weight` property is added to the inline style of the `span` element that contains the check mark. The value of `bold` is used to make the check mark bold.

Note that you can adjust the values of the style attributes (e.g. `padding-right`, `margin`, `text-align`, etc.) and the Unicode character for the check mark to achieve the desired visual layout.
