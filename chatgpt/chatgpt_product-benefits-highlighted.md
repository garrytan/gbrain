---
title: "Product Benefits Highlighted."
type: guide
created: 2023-04-03
updated: 2023-04-03
source: chatgpt-export
conversation_id: 68a5e987-5aa0-4b1d-b8c9-333c20906789
message_count: 14
tags: [chatgpt, import, code, long-form]
---
# Product Benefits Highlighted.

> Conversation ID: 68a5e987-5aa0-4b1d-b8c9-333c20906789
> Created: 2023-04-03T01:12:43Z
> Updated: 2023-04-03T01:22:44Z
> Messages: 14

---

## User

<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>

---

## Assistant

This is a HTML code for a product section of a website, which displays a featured image and highlights the key benefits of the product. The product title is displayed in uppercase letters and in bold font. 

The section is divided into three columns, each with a heading in uppercase letters, bold and larger font size, followed by a short paragraph that describes the key feature of the product. The three headings are "Scientifically Proven", "High Quality Products", and "Safe Products". 

The section has a light grey background color, with a rounded border of 20 pixels. The columns are centered with a margin at the top and padding at the left and right sides. The featured image has a rounded border of 10 pixels and is displayed at a maximum width of 20% of the section.

---

## User

edit this liquid code so that it only displays if the current product is in the supplement collection

---

## Assistant

Sure! Here's how you can modify the Liquid code to only display if the current product is in the "supplement" collection:

```
{% if collection.handle == 'supplement' %}
<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>
{% endif %}
```

In this code, we are using an if statement to check whether the current product's collection handle is "supplement". If it is, then the entire section will be displayed. If it is not, then the section will be skipped and not displayed on the page.

---

## User

lets check the product tags isntead

---

## Assistant

Sure thing! Here's how you can modify the Liquid code to only display if the current product has the tag "supplement":

```
{% if product.tags contains 'supplement' %}
<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>
{% endif %}
```

In this code, we are using an if statement to check whether the current product's tags contain the string "supplement". If it does, then the entire section will be displayed. If it does not, then the section will be skipped and not displayed on the page.

---

## User

lets add a header "THE A7X3 DIFFERENCE"

---

## Assistant

Sure! Here's how you can modify the Liquid code to add a header "THE A7X3 DIFFERENCE" to the section:

```
{% if product.tags contains 'supplement' %}
<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <h2 style="text-align: center; text-transform: uppercase; font-weight: bold; font-size: 30px; margin-bottom: 20px;">THE A7X3 DIFFERENCE</h2>
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>
{% endif %}
```

In this code, we have added an h2 header "THE A7X3 DIFFERENCE" above the existing section header. This will help distinguish this section from other sections on the page.

---

## User

{% if product.tags contains 'supplement' %}
 <h2 style="text-align: center; text-transform: uppercase; font-weight: bold; font-size: 30px; margin-bottom: 20px;">THE A7X3 DIFFERENCE</h2>
 
<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>
{% endif %}

---

## Assistant

This looks good! The header "THE A7X3 DIFFERENCE" will only display if the current product has the "supplement" tag, and the content within the div will only be displayed in that case as well.

---

## User

lets have a fallback content 

---

## Assistant

Sure! You can add a fallback content within an `{% else %}` block like this:

```
{% if product.tags contains 'supplement' %}
  <h2 style="text-align: center; text-transform: uppercase; font-weight: bold; font-size: 30px; margin-bottom: 20px;">THE A7X3 DIFFERENCE</h2>

  <div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
    <div style="text-align: center;">
      {% assign product = product %}
      <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
      <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
    </div>
    <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
      <div class="column" style="width: 33%; text-align: center;">
        <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
        <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
      </div>
      <div class="column" style="width: 33%; text-align: center;">
        <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
        <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
      </div>
      <div class="column" style="width: 33%; text-align: center;">
        <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
        <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
      </div>
    </div>
  </div>
{% else %}
  <div style="text-align: center;">
    <h2>This product is not a supplement.</h2>
    <p>Please check out our other products!</p>
  </div>
{% endif %}
```

In this case, if the current product does not have the "supplement" tag, it will display the fallback content with a message "This product is not a supplement. Please check out our other products!"

---

## User

 <div style="text-align: center;">
   <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
    <p>FREE SHIPPING ON ORDER $75+</p>
  </div>  

INSTEAD OF FREE SHIPPING BEING A SINGLE ITEM MAKE 3 COLUMNS

---

## Assistant

Sure, here's an updated code with 3 columns:

```
{% if product.tags contains 'supplement' %}
 <h2 style="text-align: center; text-transform: uppercase; font-weight: bold; font-size: 30px; margin-bottom: 20px;">THE A7X3 DIFFERENCE</h2>
 
<div class="section" style="background-color: #FAFAFA; border-radius: 20px; padding: 20px;">
  <div style="text-align: center;">
    {% assign product = product %}
    <img src="{{ product.featured_image.src | img_url: 'master' }}" style="border-radius: 10px; max-width: 20%; margin-bottom: 20px;">
    <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">HIGH QUALITY {{ product.title }} </h2>
  </div>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SCIENTIFICALLY PROVEN</h5>
      <p>We provide effective supplements that are of actual benefit to health, body composition or performance, so customers experience results and come back again</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">HIGH QUALITY PRODUCTS</h5>
      <p>We take pride in offering only the highest quality products that meet rigorous standards for purity and potency</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">SAFE PRODUCTS</h5>
      <p>We are assessed for banned substances, contaminants, concentration and bioavailability by 3rd party labs</p>
    </div>
  </div>
</div>

{% else %}

<div style="text-align: center;">
  <h2 style="text-transform: uppercase; font-weight: bold; font-size: 24px; margin-bottom: 20px;">DELIVERED TO YOUR DOOR</h2>
  <div class="columns" style="margin-top: 8px; padding-right: 10%; padding-left: 10%; display: flex; flex-wrap: wrap;">
    <div class="column" style="width: 33%; text-align: center;">
      <p><i class="fas fa-shipping-fast fa-3x" style="margin-bottom: 10px;"></i></p>
      <h5 style="text-transform: uppercase; font-weight: bold; font-size: 20px; margin-bottom: 10px;">FAST SHIPPING</h5>
      <p>Get your order delivered quickly with our fast shipping options</p>
    </div>
    <div class="column" style="width: 33%; text-align: center;">
      <p><i class="fas fa-boxes fa-3x" style="margin-bottom: 10px;"></i></p>
      <h5 style="text-transform: uppercase; font-weight: bold;


## See Also
- [[chatgpt/chatgpt_california-unemployment-benefits]]
- [[chatgpt/chatgpt_docstrings-benefits-and-necessity]]
- [[chatgpt/chatgpt_glp-1-benefits-beyond-diabetes]]
- [[chatgpt/chatgpt_m2-macbook-upgrade-benefits]]
- [[chatgpt/chatgpt_meditation-benefits-fitness]]
