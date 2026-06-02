---
title: "Liquid links for Shopify."
type: guide
created: 2023-04-13
updated: 2023-04-13
source: chatgpt-export
topic: design-ux
message_count: 16
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Liquid links for Shopify.

> **Source:** ChatGPT conversation
> **Date:** 2023-04-13T19:26:02Z
> **Messages:** 16
> **Topic:** design-ux

## Question

I need to make a list of links to display on a seciton of my shopify site. But it needs to be in liquid.

the links are 
Account
Blog
Email Sign Up
Help
Accessibility Statement
United States


## Answer

Here's an example code snippet that you can use in your Shopify liquid file to display the links:

```
<ul>
  <li><a href="/account">Account</a></li>
  <li><a href="/blogs/news">Blog</a></li>
  <li><a href="/pages/email-sign-up">Email Sign Up</a></li>
  <li><a href="/pages/help">Help</a></li>
  <li><a href="/pages/accessibility-statement">Accessibility Statement</a></li>
  <li><a href="/?locale=en-us">United States</a></li>
</ul>
```

You can customize the URLs and text for each link as needed. The code above creates an unordered list with six list items, each containing an anchor tag linking to the appropriate page.

## Question

they should display horizantally with vertical abr seperators

## Answer

To display the links horizontally with vertical bar separators, you can use the following code snippet:

```
<ul class="link-list">
  <li><a href="/account">Account</a></li>
  <li><span>|</span></li>
  <li><a href="/blogs/news">Blog</a></li>
  <li><span>|</span></li>
  <li><a href="/pages/email-sign-up">Email Sign Up</a></li>
  <li><span>|</span></li>
  <li><a href="/pages/help">Help</a></li>
  <li><span>|</span></li>
  <li><a href="/pages/accessibility-statement">Accessibility Statement</a></li>
  <li><span>|</span></li>
  <li><a href="/?locale=en-us">United States</a></li>
</ul>
```

This code creates an unordered list with class "link-list" that contains each link as a list item, separated by a span element containing a vertical bar "|". You can adjust the styling of the links and separators in your CSS file.

## Question

actually instead can we reference a menu from shopify?

## Answer

Yes, you can reference a menu from Shopify using Liquid. Here's an example code snippet that you can use to display a menu in your Shopify site:

```
{% if linklists.main-menu.links.size > 0 %}
  <ul class="link-list">
    {% for link in linklists.main-menu.links %}
      <li><a href="{{ link.url }}">{{ link.title }}</a></li>
      {% unless forloop.last %}<li><span>|</span></li>{% endunless %}
    {% endfor %}
  </ul>
{% endif %}
```

This code checks if there are any links in the main menu (assuming the main menu handle is "main-menu"). If there are links, it creates an unordered list with class "link-list" and loops through each link in the main menu, creating a list item with an anchor tag for each link. It also adds a vertical bar separator between each link, except for the last one.

Note that you may need to adjust the CSS styles for the link list and separator to match your site's design.

## Question

i want them to display inline with no bullet point.

## Answer

To display the links inline without bullet points, you can modify the code snippet from my previous response as follows:

```
{% if linklists.main-menu.links.size > 0 %}
  <ul class="link-list" style="list-style: none; display: inline;">
    {% for link in linklists.main-menu.links %}
      <li style="display: inline;"><a href="{{ link.url }}">{{ link.title }}</a></li>
      {% unless forloop.last %}<li style="display: inline; padding: 0 5px;">|</li>{% endunless %}
    {% endfor %}
  </ul>
{% endif %}
```

This code sets the style of the unordered list to "list-style: none; display: inline;", which removes the bullet points and displays the list items inline. It also sets the style of each list item to "display: inline;", which further ensures that the links display inline with each other. Finally, it adds a separator between each link using a vertical bar character and adds padding to the separator to make it more visually appealing.

Note that you can adjust the padding value to increase or decrease the spacing between the links and separators as needed.

## Question

i wanna set the bg color to ebebeb

## Answer

To set the background color of the link list to ebebeb, you can modify the code snippet from my previous response as follows:

```
{% if linklists.main-menu.links.size > 0 %}
  <ul class="link-list" style="list-style: none; display: inline; background-color: #ebebeb;">
    {% for link in linklists.main-menu.links %}
      <li style="display: inline;"><a href="{{ link.url }}">{{ link.title }}</a></li>
      {% unless forloop.last %}<li style="display: inline; padding: 0 5px;">|</li>{% endunless %}
    {% endfor %}
  </ul>
{% endif %}
```

This code adds the "background-color: #ebebeb;" property to the style attribute of the unordered list, which sets the background color of the link list to ebebeb.

Note that you can adjust the color value to any other color of your choice.

## Question

this only changed the inner secion.

## Answer

I apologize for the confusion. You can set the background color of the entire menu section by wrapping the code snippet that displays the menu links in a div with a background color. Here's an example:

```
<div style="background-color: #ebebeb;">
  {% if linklists.main-menu.links.size > 0 %}
    <ul class="link-list" style="list-style: none; display: inline;">
      {% for link in linklists.main-menu.links %}
        <li style="display: inline;"><a href="{{ link.url }}">{{ link.title }}</a></li>
        {% unless forloop.last %}<li style="display: inline; padding: 0 5px;">|</li>{% endunless %}
      {% endfor %}
    </ul>
  {% endif %}
</div>
```

This code wraps the link list in a div with a background color of #ebebeb, which sets the background color of the entire menu section.

Again, I apologize for any confusion earlier.

## Question

can you make the background color seperate css

## Answer

Yes, you can set the background color using a separate CSS class instead of an inline style attribute. Here's an example:

1. Add a new CSS class to your Shopify theme's stylesheet. You can do this by going to the "Online Store" > "Themes" > "Actions" > "Edit Code" in your Shopify admin panel and then opening the "Assets" folder and editing the "theme.scss.liquid" file (or any other stylesheet file you're using). Add the following code at the end of the file:

```
.menu-section {
  background-color: #ebebeb;
}
```

This code defines a new CSS class called "menu-section" with a background color of #ebebeb.

2. Update your Liquid code to use the new CSS class. Replace the code snippet I provided earlier with the following:

```
<div class="menu-section">
  {% if linklists.main-menu.links.size > 0 %}
    <ul class="link-list" style="list-style: none; display: inline;">
      {% for link in linklists.main-menu.links %}
        <li style="display: inline;"><a href="{{ link.url }}">{{ link.title }}</a></li>
        {% unless forloop.last %}<li style="display: inline; padding: 0 5px;">|</li>{% endunless %}
      {% endfor %}
    </ul>
  {% endif %}
</div>
```

This code wraps the link list in a div with a class of "menu-section" instead of setting the background color using an inline style attribute.

Now, the background color of the menu section will be set by the "menu-section" class defined in your stylesheet. You can change the background color by modifying the CSS class in your stylesheet without having to modify the Liquid code.

## Question

can we make the text smaller and a light gret color

## Answer

Certainly! To make the text smaller and a light gray color, you can modify the code snippet from my previous response as follows:

1. Add a new CSS class to your Shopify theme's stylesheet. You can do this by going to the "Online Store" > "Themes" > "Actions" > "Edit Code" in your Shopify admin panel and then opening the "Assets" folder and editing the "theme.scss.liquid" file (or any other stylesheet file you're using). Add the following code at the end of the file:

```
.menu-section {
  background-color: #ebebeb;
}

.menu-section a {
  color: #bbb;
  font-size: 14px;
}
```

This code defines two CSS classes: "menu-section" with a background color of #ebebeb, and "menu-section a" with a font size of 14px and a color of #bbb (a light gray color).

2. Update your Liquid code to use the new CSS classes. Replace the code snippet I provided earlier with the following:

```
<div class="menu-section">
  {% if linklists.main-menu.links.size > 0 %}
    <ul class="link-list" style="list-style: none; display: inline;">
      {% for link in linklists.main-menu.links %}
        <li style="display: inline;"><a href="{{ link.url }}">{{ link.title }}</a></li>
        {% unless forloop.last %}<li style="display: inline; padding: 0 5px;">|</li>{% endunless %}
      {% endfor %}
    </ul>
  {% endif %}
</div>
```

This code wraps the link list in a div with a class of "menu-section" and sets the font size and color of the links using the "menu-section a" class defined in your stylesheet.

Now, the text of the links will be smaller and a light gray color. You can adjust the font size and color values in your CSS class to your liking.
