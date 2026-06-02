---
title: "Shopify code installment pricing"
type: note
created: 2023-05-03
updated: 2023-05-03
source: chatgpt-export
conversation_id: 50bd77b0-b6ff-4bab-8d8d-5cfb694684d7
message_count: 2
tags: [chatgpt, import, code]
---
# Shopify code installment pricing

> Conversation ID: 50bd77b0-b6ff-4bab-8d8d-5cfb694684d7
> Created: 2023-05-03T17:44:25Z
> Updated: 2023-05-03T17:45:48Z
> Messages: 2

---

## User

<h3>Checkout today. Interest free.</h3>
<ul><li><a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/klarna" title="Klarna" target="_blank" rel="noreferrer"><span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;"><img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://cdn.shopify.com/s/files/1/0517/3582/2533/files/afterpay-lockup-blackonmint.svg?v=1683135243" ></span><div>Pay in 4 installments of $11.50<span class="payment-provider_min-price__jW6IR"><br>Minimum order value of $35</span></div></a></li></ul>


make this shopify liquid code and make the installment price dynmic based on the product pricee divided by 4

---

## Assistant

```
{% assign product_price = product.price | money_without_currency %}
{% assign installment_price = product_price | divided_by:4 %}
{% if installment_price >= 35 %}
  <ul>
    <li>
      <a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/klarna" title="Klarna" target="_blank" rel="noreferrer">
        <span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;">
          <img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://cdn.shopify.com/s/files/1/0517/3582/2533/files/afterpay-lockup-blackonmint.svg?v=1683135243">
        </span>
        <div>Pay in 4 installments of {{ installment_price | money }}<span class="payment-provider_min-price__jW6IR"><br>Minimum order value of $35</span></div>
      </a>
    </li>
  </ul>
{% endif %}
```

Explanation:
- The `product_price` variable is assigned the value of the product price converted to a string with the `money_without_currency` filter, which removes the currency symbol from the output.
- The `installment_price` variable is assigned the value of the product price divided by 4.
- The code checks if the `installment_price` is greater than or equal to 35, the minimum order value.
- If the condition is met, the code outputs the Klarna payment link with the installment price and the minimum order value. The `installment_price` variable is converted to a string with the `money` filter, which adds the currency symbol to the output.


**Topic:** [[chatgpt-clusters/coding_ai]]
