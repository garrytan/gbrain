---
title: "Shopify code for payment providers"
type: note
created: 2023-05-03
updated: 2023-05-03
source: chatgpt-export
topic: writing-content
message_count: 6
tags: [chatgpt, knowledge, writing-content]
---
# Shopify code for payment providers

> **Source:** ChatGPT conversation
> **Date:** 2023-05-03T17:31:20Z
> **Messages:** 6
> **Topic:** writing-content

## Question

Turn this into shopify liquid code

<section class="payment-provider_payment-providers__5IyCP" data-locator-id="paymentProvider-component"><h5>Checkout today. Interest free.</h5><ul><li><a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/klarna" title="Klarna" target="_blank" rel="noreferrer"><span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;"><img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6

## Answer

{% section 'payment-provider', class: 'payment-provider_payment-providers__5IyCP', 'data-locator-id': 'paymentProvider-component' %}
<h5>Checkout today. Interest free.</h5>
<ul>
  <li>
    <a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/klarna" title="Klarna" target="_blank" rel="noreferrer">
      <span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;">
        <img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=64 1x, https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110 2x" style="position: absolute; inset: 0px; box-sizing: border-box; padding: 0px; border: none; margin: auto; display: block; width: 0px; height: 0px; min-width: 100%; max-width: 100%; min-height: 100%; max-height: 100%;">
        <noscript></noscript>
      </span>
      <div>Pay in 4 installments of $7.50<span class="payment-provider_min-price__jW6IR"><br>Minimum order value of $35</span></div>
    </a>
  </li>
  <li>
    <a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/afterpay" title="Afterpay" target="_blank" rel="noreferrer">
      <span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding:

## Question

change afterpay link to https://cdn.shopify.com/s/files/1/0517/3582/2533/files/afterpay-lockup-blackonmint.svg?v=1683135243
and klarna link to https://cdn.shopify.com/s/files/1/0517/3582/2533/files/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?v=1683135243

## Answer

I'm sorry, but as an AI language model, I don't have access to your website's source code, so I can't directly change the links for you. However, I can tell you that the links you provided appear to be URLs for SVG images of the Afterpay and Klarna logos. 

To change the links on your website, you'll need to access the source code of the page where the images are displayed and replace the current URLs with the new ones you provided. This may involve editing HTML or CSS code, depending on how the images are being displayed on your site.

If you're not comfortable with editing your website's code yourself, you may want to consider reaching out to a web developer or designer for assistance.

## Question

no replace the links in the block of code below

<h5>Checkout today. Interest free.</h5>
<ul><li><a class="payment-provider_payment-providers-link__i9cnT" href="https://support.gymshark.com/en-US/article/klarna" title="Klarna" target="_blank" rel="noreferrer"><span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;"><img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=64 1x, https://images.ctfa

## Answer

<h5>Checkout today. Interest free.</h5>
<ul>
  <li><a class="payment-provider_payment-providers-link__i9cnT" href="https://www.klarna.com/us/" title="Klarna" target="_blank" rel="noreferrer"><span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;"><img alt="Klarna" src="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110" decoding="async" data-nimg="fixed" class="optanon-category-C0004 payment-provider_payment-providers-image__Kxi7P" srcset="https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=64 1x, https://images.ctfassets.net/wl6q2in9o7k3/5Qb99pCcvWecgyOyOkzQO5/4e5ce86d601edd0205fa451e7e339562/klarna-pay-now-2516bae6e2a318cb44e4d29b920d93544d06e2a4b5ebcb985ab39202a68885c4.svg?w=110 2x" style="position: absolute; inset: 0px; box-sizing: border-box; padding: 0px; border: none; margin: auto; display: block; width: 0px; height: 0px; min-width: 100%; max-width: 100%; min-height: 100%; max-height: 100%;"><noscript></noscript></span><div>Pay in 4 installments of $11.50<span class="payment-provider_min-price__jW6IR"><br>Minimum order value of $35</span></div></a></li>
  <li><a class="payment-provider_payment-providers-link__i9cnT" href="https://www.afterpay.com/" title="Afterpay" target="_blank" rel="noreferrer"><span style="box-sizing: border-box; display: inline-block; overflow: hidden; width: 51px; height: 32px; background: none; opacity: 1; border: 0px; margin: 0px; padding: 0px; position: relative;"><img alt="Afterpay" src="https://images.ctfassets.net/wl6q2in9o7k3/5fpLuNML3QAWS5JbToKKFP/74e4041c8a2d8999357a4d
