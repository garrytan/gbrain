---
title: "SpaceX Stock Inheritance"
type: note
created: 2026-05-17
updated: 2026-05-17
source: chatgpt-export
conversation_id: 6a0a2446-3308-83e8-86ab-856d316c93d3
message_count: 2
tags: [chatgpt, import, long-form]
---
# SpaceX Stock Inheritance

**Related:** [[personal_finance]]

> Conversation ID: 6a0a2446-3308-83e8-86ab-856d316c93d3
> Created: 2026-05-17T20:30:04Z
> Updated: 2026-05-17T20:30:19Z
> Messages: 2

---

## User

I have $100,000 of um SpaceX stock that my uncle bought in 2018. He's now dead. He lived in Nevada. My mom inherited it all. She controls it. She lives in New Jersey. Um, she's got me managing it. And Forge, I think, is the company that's like dealing with it. Um, you know, I think with, it's like a financial advisor or something. I don't know if it was through an RUV or if it was purchased, an angel investment directly, or what the deal was. I'm pretty sure it was an RUV or some kind of like deal or something. I don't know if it was secondary shares, like bought from employee options, or if it was like a direct investment in a round or something. I have no idea of the context. Um, but before I get on a call, um, they're going public June 11th. I'm assuming there's kind of a lockup. I'm gonna wanna probably hold it forever if possible, but I don't know if it's gonna be like, if it's an RUV, do they just sell it and then I just get the, I just get the money? Or do, and like I have no option to retain the stock, or do they give me the stock? And then tell me what the implications are, like stock-wise and stuff, if, if it is sold, and then I just wanna go rebuy it publicly. Like, that seems like not an ideal situation. I basically take the tax hit on it at full value and then have to go repurchase it, probably at an inflated value. You know what I mean? So like that seems like a fucking shit show. Um, and then if they transfer over the stock, kind of what's the deal of like, um, you know, can I just hold it for as long as I want? What's kind of like the implications? I'm assuming there's a six-month lockup on it. Do I hedge? Do I buy puts against the value of the portfolio value? Um, do I know what that value is? Do I... Buy them with an expiration that's six months out? Do I go seven months out? Do I go a year out? Do I hedge for just the lockup period or do I hedge for longer term instability? Or do we hedge against the six months and then reevaluate or like eight months, nine months, one year, and then reevaluate? You know, and then give me like the systematic ways to think about it. If it is a hedge or something, what are my dependencies on my decision making? And then if I am hedging, is it like, you know, if X, then like what's information parity, you know, kind of what are my exit points, what are my entry points? Basically, you know, and then, you know, I'm assuming the financial advisor is gonna, is gonna encourage a sale because until there's a liquidity event, they're not gonna be able to take any profit on it. So I wanna avoid the noise from that. Can you just like concisely break down like each scenario and then what the ideal situations are for how to tackle it. But don't, you know, don't like mix it up with, you know, keep it, keep it concise. I don't wanna read an essay.

---

## Assistant

This depends almost entirely on what your mom actually owns. There are 4 main scenarios:

1. Direct SpaceX shares  
2. Shares held through an SPV/RUV/fund vehicle  
3. Convertible instrument/SAFE-style exposure  
4. Synthetic exposure where you never actually receive stock

The answer changes dramatically depending on which one it is.

Key question for the call:
“Do we directly own SpaceX common/preferred shares, or do we own interests in an SPV/fund that itself owns the shares?”

Also ask:
- What exact security type do we own?
- Is it transferable?
- Who is the custodian?
- Is there a lockup?
- Are there distribution rights?
- Can shares be transferred in-kind to beneficiaries?
- What is the stepped-up tax basis after death?

That last one is extremely important.

If your uncle died holding it, there is a strong chance the position received a step-up in basis at date of death. That can massively reduce taxes.

Scenario 1: You directly own shares
Best-case scenario.

Likely outcome:
- IPO/direct listing happens
- Lockup applies (commonly ~180 days)
- After lockup, you can:
  - hold forever
  - sell partially
  - hedge
  - borrow against it eventually

Tax:
- If stepped-up basis applies, gains may only be from death-date value forward, not 2018 value.

This is the cleanest outcome.

Scenario 2: SPV/RUV/fund owns shares
Very common with late-stage private deals.

Potential outcomes:
- The vehicle distributes actual shares to investors
- OR the vehicle liquidates and distributes cash

This is where your concern is valid.

If they liquidate automatically:
- you may trigger taxes
- lose original exposure
- then have to rebuy at public prices

That is materially worse than receiving shares in-kind.

Important question:
“Will the vehicle distribute shares or cash after liquidity?”

That is probably the single most important question on the call.

Scenario 3: Forced liquidation
Worst practical outcome.

You get:
- cash distribution
- taxable event
- then must rebuy manually

Problems:
- taxes
- market gap risk
- emotional re-entry problems
- public market volatility

If this is happening, ask:
- Can we elect in-kind distribution instead of liquidation?
- Can ownership transfer into brokerage form?
- Can we defer sale?

Scenario 4: Long-term hold
Probably optimal if:
- you believe in SpaceX long-term
- taxes are favorable
- concentration risk is acceptable

The real danger here is concentration risk, not “missing upside.”

At $100k, concentration risk is manageable unless it becomes most of net worth later.

Lockup thinking
Assume ~180 days until confirmed otherwise.

During lockup:
- you cannot sell
- sometimes cannot hedge
- insiders often have restrictions on derivatives too

You need to ask:
“Are hedging transactions permitted during lockup?”

Do not assume yes.

Hedging framework
You hedge for one of two reasons:
1. You need capital protection
2. Position size becomes psychologically or financially dangerous

Not because “volatility exists.”

Your framework:
- If SpaceX becomes >20–30% of liquid net worth → consider hedging/reduction
- If you need the money in next 2–5 years → hedge more aggressively
- If this is generational capital and taxes are favorable → hedge minimally

Most systematic approach:
- Hold through lockup
- Reevaluate after earnings/public trading stabilizes
- Decide then:
  - hold
  - collar
  - protective puts
  - partial sale

Puts
If hedging:
- buy after volatility cools post-IPO if possible
- longer-dated puts are usually cleaner
- 9–12 months often more rational than exactly matching lockup

Why:
- post-lockup volatility often persists
- insiders selling creates pressure
- implied volatility structure changes

Most people overhedge too early and overpay.

A collar is often more capital-efficient:
- buy downside put
- sell upside call
- reduces hedge cost

But caps upside.

Your biggest dependencies
1. Security structure  
2. Step-up basis status  
3. Lockup restrictions  
4. Whether shares or cash get distributed  
5. Concentration relative to future net worth  
6. Your actual desire for long-term exposure

Important meta-point
You are correct to be skeptical of incentives.

Liquidity-event advisors often prefer transactions because transactions create fees.

Your default stance should be:
“How do we preserve long-term ownership in the most tax-efficient way possible?”

That is the right framing going into the call.


**Topic:** [[chatgpt-clusters/personal_finance]]
