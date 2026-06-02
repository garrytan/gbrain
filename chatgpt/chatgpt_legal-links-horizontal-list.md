---
title: "Legal links horizontal list."
type: note
created: 2023-04-02
updated: 2023-04-02
source: chatgpt-export
conversation_id: 6f91e3c8-a0b0-4fb3-b177-f5241ac1866d
message_count: 4
tags: [chatgpt, import, code]
---
# Legal links horizontal list.

> Conversation ID: 6f91e3c8-a0b0-4fb3-b177-f5241ac1866d
> Created: 2023-04-02T04:20:03Z
> Updated: 2023-04-02T04:22:52Z
> Messages: 4

---

## User

{%- if section.settings.show_payment_methods -%}
        {%- capture payment_methods -%}
          {%- for type in shop.enabled_payment_types -%}
            <li class="HorizontalList__Item">{{ type | payment_type_svg_tag }}</li>
          {%- endfor -%}
        {%- endcapture -%}

        {%- if payment_methods != blank -%}
          <ul class="Footer__PaymentList HorizontalList">
            {{ payment_methods }}
          </ul>
        {%- endif -%}
      {%- endif -%}

change this so instead of showing payment methods it shows a horizantal list of links from the menu called Legal

---

## Assistant



Here's the modified code that displays a horizontal list of links from the menu called Legal instead of showing payment methods:

```
{% if section.settings.show_legal_links %}
  {% assign legal_links = linklists['legal'] %}
  {% if legal_links.links.size > 0 %}
    <ul class="Footer__LegalLinks HorizontalList">
      {% for link in legal_links.links %}
        <li class="HorizontalList__Item"><a href="{{ link.url }}">{{ link.title }}</a></li>
      {% endfor %}
    </ul>
  {% endif %}
{% endif %}
```

Note that we first check if the `show_legal_links` setting is enabled in the section, and then we get the links from the `legal` link list using the `linklists` object. We then check if there are any links in the list, and if so, we loop through them and output each link as a list item with an anchor tag. Finally, we wrap the list items in a `ul` element with the `Footer__LegalLinks` and `HorizontalList` classes to create a horizontal list.

---

## User

now lets style the links to be very small and gray and white on hover.  

---

## Assistant

Sure! Here's the updated code with CSS styles added to make the links small and gray by default, and white on hover:

```
{% if section.settings.show_legal_links %}
  {% assign legal_links = linklists['legal'] %}
  {% if legal_links.links.size > 0 %}
    <ul class="Footer__LegalLinks HorizontalList">
      {% for link in legal_links.links %}
        <li class="HorizontalList__Item"><a href="{{ link.url }}" style="font-size: 12px; color: #777777; text-decoration: none;">{{ link.title }}</a></li>
      {% endfor %}
    </ul>
  {% endif %}
{% endif %}

<style>
.Footer__LegalLinks a {
  transition: color 0.3s ease-in-out;
}

.Footer__LegalLinks a:hover {
  color: #ffffff;
}
</style>
```

In the HTML, we added inline styles to the anchor tags to make the font size small and the color gray. In the CSS, we added styles to transition the link color on hover, and to change the color to white when the link is hovered over. We also added a new CSS class `.Footer__LegalLinks` to style the legal links separately from other links on the page, and to ensure that the styles only apply to the legal links in the footer.
