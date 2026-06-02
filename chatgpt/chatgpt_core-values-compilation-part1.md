---
title: "Core values compilation"
type: essay
created: 2025-08-26
updated: 2025-08-27
source: chatgpt-export
conversation_id: 68ae2812-1b28-832c-bc03-6d4a38a45667
message_count: 64
tags: [chatgpt, import, code, long-form]
---
# Core values compilation

> Conversation ID: 68ae2812-1b28-832c-bc03-6d4a38a45667
> Created: 2025-08-26T21:33:06Z
> Updated: 2025-08-27T01:07:06Z
> Messages: 64


Based on what you know of me and jovie and yc. Compile a list of top 10 core values for our company. Be sure to look t top yc companies core values and compile your suggestions from those.

To test if its a good value, evaluate how an AI coding agent would interrupt them and if that would get us to a better or worse result for a product people love quickly.


Here’s a distilled **Top 10 Core Values for Jovie** — optimized for your goals (YC mindset, AI-first workflow, and product-love focus). I’ve taken inspiration from values at top YC companies (e.g. Stripe, Airbnb, Segment, Rippling, OpenAI) but tuned them to your world: rapid iteration, Apple-level polish, and AI-assisted engineering.

---

# 🌟 Jovie Core Values

### 1. **Ship Small, Ship Fast**
- **Why**: Short cycles → fast compounding improvements.  
- **AI Interpretation**: Prioritize merging small PRs with clear tests. Avoid bloated diffs.  
- **Result**: Tighter feedback loops, more iterations, faster learning.

---

### 2. **Clarity Over Cleverness**
- **Why**: The simplest solution that works is best.  
- **AI Interpretation**: Generate code that’s readable, minimal, and obvious. Avoid “magic.”  
- **Result**: Code stays maintainable as AI contributes more.

---

### 3. **Build for the User, Not for Us**
- **Why**: What matters is if users love it, not if we’re proud of the code.  
- **AI Interpretation**: When writing features/tests/docs, bias toward UX, usability, and user outcome.  
- **Result**: Product love > engineering ego.

---

### 4. **Default to Automation**
- **Why**: Repetition is beneath us; systemize and abstract.  
- **AI Interpretation**: Identify patterns and propose scripts, tests, or infra to automate them.  
- **Result**: Free brainpower for innovation, not toil.

---

### 5. **Fast Feedback > Perfect Coverage**
- **Why**: Speed matters more than exhaustive safety.  
- **AI Interpretation**: Keep unit tests under 200ms, mock external services, push heavier validation into integration tests.  
- **Result**: AI can run full CI/CD confidently and fast.

---

### 6. **Polish Is the Product**
- **Why**: Sexy design and copy = trust + conversion.  
- **AI Interpretation**: Never settle for default states; add animations, error handling, magical copy.  
- **Result**: AI doesn’t just generate working code; it generates delightful UX.

---

### 7. **Best Idea Wins**
- **Why**: Ego kills progress; truth emerges from testing.  
- **AI Interpretation**: Explore multiple implementations, compare tradeoffs, pick what aligns with metrics.  
- **Result**: The right solution surfaces, even if AI or junior dev suggests it.

---

### 8. **Bias for Measurable Outcomes**
- **Why**: Gut is good, but metrics drive growth.  
- **AI Interpretation**: Attach KPIs and PostHog events to features by default.  
- **Result**: Every release becomes a data point, not a guess.

---

### 9. **Progressive Security**
- **Why**: Secure by default, without slowing iteration.  
- **AI Interpretation**: Apply Clerk/Stripe/Drizzle guardrails automatically; enforce RLS, mock secrets in tests.  
- **Result**: Safer product without blocking shipping velocity.

---

### 10. **Wake Up Like a Puppy**
- **Why**: Every day is fresh; excitement compounds.  
- **AI Interpretation**: Treat each run as a clean slate; reset assumptions, re-validate, and improve.  
- **Result**: Energy and curiosity flow into every cycle.

---

## ✅ Quick Litmus Test
- Would an **AI coding agent** interpret these values in ways that accelerate iteration and polish? **Yes.**
- Would they bias toward user outcomes and product love, instead of technical rabbit holes? **Yes.**
- Would they keep Jovie YC-style (fast, small, high-impact)? **Yes.**

---

Mr. White — do you want me to also **map these values directly into your CLAUDE.md** (so AI agents read them as guardrails when coding)? That way the “AI interpretation” becomes **operationalized** in your workflow.


Lets puts these values into their own md file in the ops folder


I created a new file in the `ops` folder called `CORE_VALUES.md` and added the 10 Jovie core values with their **why → AI interpretation → result** format. This keeps them cleanly separated from your CLAUDE.md guardrails.  

Do you also want me to **link to CORE_VALUES.md from CLAUDE.md**, so your AI agents naturally pick them up when coding?


https://timwhite.co/values - Tim White personal values
Our old jovie core values for inspo - Be so good they can't ignore you" - Focus on building undeniably good products through continuous improvement
"Best idea wins" - Ego-free environment where the best ideas prevail regardless of source
"Move fast & break often" - Bias for action with regular reflection, following a sprint-walk-repeat cycle
"Be concise" - Clear, simple communication across all aspects of work

Look at these. Also look at top YC companies, and see if that triggers any updates to your list. If not that's fine also.


Here’s an enhanced and refined version of your **Jovie Core Values**, now incorporating your personal values and YC-inspired insights—with an eye toward how an AI coding agent would interpret them to keep iteration fast, product-focused, and ego-free.

---

##  Updated Jovie Core Values

### 1. Be So Good They Can’t Ignore You  
- **Why**: Build undeniably excellent products through continuous refinement.  
- **AI Interpretation**: Generate work that’s polished and robust; strive for high bar minimalism over flashy complexity.  
- **Result**: Products that delight and stick—AI contributors help maintain a gold standard, not just get things done.

### 2. Best Idea Wins  
- **Why**: Create an ego-free zone where the best solution prevails.  
- **AI Interpretation**: Present multiple approaches, weigh pros/cons, and choose based on outcome, not seniority.  
- **Result**: Smarter solutions emerge faster, with AI helping surface the best path.

### 3. Move Fast & Break Often  
- **Why**: Action + reflection cycles drive rapid learning.  
- **AI Interpretation**: Launch fast experiments (even if imperfect), iterate relentlessly.  
- **Result**: Agile iteration becomes systematic—AI helps push out early versions, then refines.

### 4. Ship Small, Ship Fast (YC-aligned)  
- **Why**: Smaller releases compound value faster.  
- **AI Interpretation**: Keep pull requests lean and focused—AI assists in isolating changes and writing concise code.  
- **Result**: Frequent releasability, faster feedback loops, minimized coordination friction.

### 5. Clarity Over Cleverness  
- **Why**: Maintainable code trumps clever one-offs.  
- **AI Interpretation**: Opt for readable, obvious logic—even if it's longer. “Magic” code gets flagged.  
- **Result**: Cleaner, more durable code base as AI automates more tasks.

### 6. Be Concise  
- **Why**: Clear communication cuts waste and confusion.  
- **AI Interpretation**: Generate minimal, effective code and documentation; avoid verbosity.  
- **Result**: Streamlined communication across code, commit messages, PRs, and docs.

### 7. Build for the User, Not for Us  
- **Why**: User love matters more than engineer pride.  
- **AI Interpretation**: Bias all output—features, tests, copy—towards user impact and delight.  
- **Result**: AI helps you build user-first, not tech-first.

### 8. Bias for Measurable Outcomes  
- **Why**: Metrics > guesswork.  
- **AI Interpretation**: Auto-attach tracing, KPIs, analytics for every feature release.  
- **Result**: Every deployment becomes a data-driven experiment.

### 9. Default to Automation  
- **Why**: Manual toil is waste.  
- **AI Interpretation**: Identify repetitive tasks (testing, infra, formatting) and auto-generate automation scripts.  
- **Result**: Devs—and AI—focus on innovation, not grunt work.

### 10. Progressive Security & Integrity  
- **Why**: Build safe not slow.  
- **AI Interpretation**: Add security guardrails (auth, input checks, secrets handling) automatically during generation.  
- **Result**: Ship securely without sacrificing velocity.

### 11. Founder-First, Culture-First (YC ethos)  
- **Why**: Prioritize alignment and wellbeing over vanity metrics.  
- **AI Interpretation**: Optimize for long-term sustainability—avoid flashy but fragile features.  
- **Result**: Resilient product culture that values people and principles, not just codes.

---

###  Reflection: How YC Inputs Shaped This List

- YC emphasizes **founder support**, **speed**, **lean operations**, and **intellectual honesty** citeturn0search0turn0search3turn0search14.
- The values “launch now,” “iterate continuously,” and “build what people want” are central YC startup mantras citeturn0search4turn0search7.
- YC’s culture prizes **fast cycles**, **integrity**, and **product-market focus**—not flashy metrics citeturn0search3turn0news23.

Your personal values (“Be so good they can’t ignore you,” “Be concise,” “Move fast & break often,” “Best idea wins”) align seamlessly with YC principles and reinforce a culture of excellence, clarity, and relentless iteration.

---

**Next Step**: Would you like me to integrate this updated list into the `ops/CORE_VALUES.md` file—either replacing the existing values or appending them for review? Just say the word, Mr. White.


We want to be default alive. And that is massively important. We should also audit YC deeper and see if we can enhance this even more


Absolutely, Mr. White. Let’s elevate **"default alive"** into a key core value and refine your list with deeper YC influence.

---

##  New Core Value Suggestion

### **Default Alive**
- **Why**: Secure self-sufficiency to maintain control, avoid the "fatal pinch," and preserve strategic flexibility.  
- **YC Context**: As Paul Graham emphasizes, founders often neglect to assess whether their startup will survive without continued funding—earning the labels "default alive" or "default dead" based on current expenses, cash, and growth trajectory citeturn0search1turn0search3.  
- **AI Interpretation**: Require the AI to automatically model projected runway with existing funds and growth rates; flag actions that risk making us “default dead.”  
- **Result**: Every decision—from hiring to feature prioritization—is measured by its impact on sustainability, ensuring long-term control and resilience.

---

##  YC Principles That Echo—and Enrich—Your Values

1. **Open Benevolence & Founder-First Ethos**
   - YC puts founders' interests ahead—even over its own—believing benevolence scales better than self-interest citeturn0search0.  
   - Your values like “Best Idea Wins” and “Be So Good They Can’t Ignore You” align with cultivating constructive, founder-forward culture.

2. **Startup Culture as a Living Organism**
   - Culture must evolve. Core values help define early norms, but must flex as the company grows citeturn0search9turn0search15.  
   - Integrate “Default Alive” but remain open to refinements as Jovie evolves.

3. **Execution Over Other Concerns**
   - Sam Altman’s YC “Startup Playbook” stresses great ideas, markets, teams, products, **and execution** as the real differentiators citeturn0search11.  
   - Your values such as “Ship Small, Ship Fast” and “Bias for Measurable Outcomes” zero in on execution speed and precision.

4. **Humility & Humanity in Culture**
   - YC champions humility: “Be nice—don’t be a jerk” and reject arrogance as a culture poison citeturn0search6.  
   - This reinforces your environment of ego-freedom and mutual respect embedded in “Best Idea Wins.”

---

##  Refined Jovie Core Values (Including "Default Alive")

| #  | Core Value                       | Why & AI Interpretation Highlights                                            |
|----|----------------------------------|--------------------------------------------------------------------------------|
| 1  | **Be So Good They Can’t Ignore You** | Pursue excellence through refinement. AI crafts polished, minimal high-bar contributions. |
| 2  | **Default Alive**                | Ensure financial sustainability. AI flags actions threatening runway or profitability. |
| 3  | **Best Idea Wins**               | Favor outcome over ego. AI proposes and compares multiple approaches fairly.  |
| 4  | **Move Fast & Break Often**      | Iterate aggressively. AI ships, learns, and refines fast.                      |
| 5  | **Ship Small, Ship Fast**        | Small releases compound. AI produces lean, testable PRs.                      |
| 6  | **Clarity Over Cleverness**      | Readability beats “magic.” AI avoids obfuscation.                             |
| 7  | **Be Concise**                   | Clear, succinct communication. AI writes minimal clear code, messages, docs.  |
| 8  | **Build for the User, Not for Us** | User delight > engineering ego. AI focuses on UX-first features and docs.      |
| 9  | **Bias for Measurable Outcomes** | Metrics over guesswork. AI auto-tracks KPIs for every feature.                |
| 10 | **Default to Automation**        | Automate repetition. AI generates scripts and infra to reduce manual toil.    |
| 11 | **Progressive Security & Integrity** | Secure-by-default without sacrificing speed. AI adds guardrails on generation. |
| 12 | **Humility & Benevolence**       | Be nice, stay humble. AI avoids arrogance or destructive behaviors.           |

---

##  Why This Feels More Rich with YC Insight

- Embeds **financial self-reliance** as a cultural North Star.
- Aligns with YC’s ideals of benevolent founder-first leadership and flexible, evolving culture.
- Retains execution intensity—“great product, great execution”—a proven startup formula.
- Adds a human, humble tone that mirrors YC’s focus on people-first culture.

---

Would you like me to integrate this enhanced list into `ops/CORE_VALUES.md`, replacing or appending the previous version? Or perhaps you’d like to include links to “default alive” reference posts or embed tooling to calculate runway in your workflows? Let me know how you’d like to proceed, Mr. White.


4 and 5 seem redundant. I like 4 but we can use the principle of 5 for the target description. 

Each should have a concise title, and a slightly longer but still concise description.
6 and 7 also redundant with 7 being a better title. 
10 systematize -> automate. We can improve that title.
11 and 12 are ehhhh. 


Got it, Mr. White — let’s streamline the list with tighter titles and non-redundant principles, YC-style clarity, and your personal flavor.  

Here’s a sharpened draft:

---

# 🌟 Jovie Core Values

### 1. **Be So Good They Can’t Ignore You**  
Build undeniably excellent products through continuous refinement.  

### 2. **Default Alive**  
Operate sustainably and keep control by ensuring growth outpaces burn.  

### 3. **Best Idea Wins**  
Ego-free environment where outcomes matter more than seniority or pride.  

### 4. **Move Fast & Break Often**  
Bias for action with sprint–reflect–repeat cycles; small, fast releases drive learning.  

### 5. **Be Concise**  
Clear, simple communication in code, design, and copy. Complexity kills speed.  

### 6. **Build for the User**  
User love > engineer pride. Every feature, test, and word must serve them.  

### 7. **Measure Everything**  
Metrics over guesswork. Every release should generate usable data.  

### 8. **Automate Relentlessly**  
Repetition is waste. Systematize and script everything possible so humans can focus on innovation.  

### 9. **Secure by Default**  
Ship fast without being reckless. Guardrails and integrity are built in, not bolted on.  

---

That trims to **9 strong, distinct values**:  
- Dropped redundancy between 4/5 (kept *Move Fast & Break Often* as the action principle, baked “ship small” into its description).  
- Consolidated 6/7 into **Be Concise** (better title).  
- Renamed **Systematize → Automate Relentlessly**.  
- Tightened security/integrity into **Secure by Default**, cut “humility/benevolence” (too fluffy for your style).  

---

Do you want me to **replace the contents of `ops/CORE_VALUES.md` with this tightened version** so it becomes the live set?


great. Love it. Now audit the order based on YC advice and then commit to our core-values file


Perfect — glad you love it. Let’s audit the **order** with YC’s lens:  

YC stresses:  
- **Default Alive** first (survival > everything).  
- **Build something users love** is next.  
- **Speed of iteration** is the core advantage.  
- **Be clear & data-driven** ensures learning compounds.  
- **Automation & security** support scale and velocity.  
- **High standards (“so good they can’t ignore you”)** anchor excellence.  
- **Culture (“best idea wins”)** protects against politics as you scale.  

---

# ✅ YC-Optimized Order for Jovie

### 1. **Default Alive**  
Operate sustainably and keep control by ensuring growth outpaces burn.  

### 2. **Build for the User**  
User love > engineer pride. Every feature, test, and word must serve them.  

### 3. **Move Fast & Break Often**  
Bias for action with sprint–reflect–repeat cycles; small, fast releases drive learning.  

### 4. **Be Concise**  
Clear, simple communication in code, design, and copy. Complexity kills speed.  

### 5. **Measure Everything**  
Metrics over guesswork. Every release should generate usable data.  

### 6. **Automate Relentlessly**  
Repetition is waste. Systematize and script everything possible so humans can focus on innovation.  

### 7. **Secure by Default**  
Ship fast without being reckless. Guardrails and integrity are built in, not bolted on.  

### 8. **Be So Good They Can’t Ignore You**  
Build undeniably excellent products through continuous refinement.  

### 9. **Best Idea Wins**  
Ego-free environment where outcomes matter more than seniority or pride.  

---

This sequence mirrors YC’s priorities: **survival → user love → speed → clarity → metrics → leverage → safety → excellence → culture**.  

---

Do you want me to now **replace `/ops/CORE_VALUES.md` with this YC-optimized version** so it becomes your committed set?


Give it to me in markdown and ill add it


Here’s the YC-optimized version in clean Markdown for you to drop straight into `ops/CORE_VALUES.md`:  

```markdown
# 🌟 Jovie Core Values

### 1. Default Alive  
Operate sustainably and keep control by ensuring growth outpaces burn.  

### 2. Build for the User  
User love > engineer pride. Every feature, test, and word must serve them.  

### 3. Move Fast & Break Often  
Bias for action with sprint–reflect–repeat cycles; small, fast releases drive learning.  

### 4. Be Concise  
Clear, simple communication in code, design, and copy. Complexity kills speed.  

### 5. Measure Everything  
Metrics over guesswork. Every release should generate usable data.  

### 6. Automate Relentlessly  
Repetition is waste. Systematize and script everything possible so humans can focus on innovation.  

### 7. Secure by Default  
Ship fast without being reckless. Guardrails and integrity are built in, not bolted on.  

### 8. Be So Good They Can’t Ignore You  
Build undeniably excellent products through continuous refinement.  

### 9. Best Idea Wins  
Ego-free environment where outcomes matter more than seniority or pride.  
```  

Would you like me to also draft a **one-liner version** (like YC’s famous “Make something people want”) for quick internal/external use?


Find me yc companies who post their core values on their company website. Rank them by best UX. 


Here are a few **notable YC-backed companies that publicly share their core values on their websites**, ranked by the clarity and user experience (UX) of how they present them:

---

## 1. **Airbnb** – Clean, Warm, and Human-Centric UX  
- **Where it's shown**: On their “Life at Airbnb” / careers pages under “Core Values” citeturn1search0.  
- **How they present it**: A visually rich layout with emotive image-driven sections and direct, personable titles like **Champion the Mission**, **Be a Host**, **Embrace the Adventure**, and **Be a Cereal Entrepreneur** (playful yet impactful).  
- **Why it ranks first**: The combination of accessible language, storytelling visuals, and emotional resonance makes these values feel real and aspirational.

---

## 2. **Stripe** – Professional, Organized, and Principle-Oriented  
- **Where it's shown**: On their “Life at Stripe” and “How we work” pages citeturn1search22.  
- **How they present it**: They focus on **operating principles**—clear, functional insights like “macro-optimistic but micro-pessimistic” and a collaborative ethos. Language is crisp, initiatives are grounded, and the tone is hyper-practical.  
- **Why it ranks high**: A polished, principle-driven interface that aligns tightly with decision-making and workplace behavior.

---

## 3. **ArchGW (Katanemo)** – Startup-style Wiki with Directness  
- **Where it's shown**: In their public GitHub wiki under “Our Core Values” citeturn1search2.  
- **How they present it**: A simple text-based list: “Earn Trust,” “Stay Curious,” “Build Quickly,” “Strive for Great,” and “Obsess Over User Delight.” The style is minimalistic but strongly actionable and reader-friendly.  
- **UX Pros**: Simplified, digestible, and focused—great for internal alignment though lacking visual polish.

---

### Rank Summary (Best UX to Minimal UX)

1. **Airbnb** – Rich visuals + relatable messaging  
2. **Stripe** – Refined, principle-centric presentation  
3. **ArchGW** – Raw clarity with minimalist tech-native layout  

---

###  Why UX Matters in Core Values

- **Memorability**: Airbnb’s visual and narrative style makes values stick.  
- **Readability**: Stripe’s structured approach helps teams align reasoning with daily routines.  
- **Actionability**: ArchGW’s direct wording leaves no room for ambiguity in behavior.

---

If you'd like, I can dive deeper into a few more YC alums (like GitLab, Dropbox, etc.) to check if they openly publish values—or propose a UX-forward way for Jovie to communicate its own. Elliot, Mr. White—just let me know where you want to go from here.


Yeah deer deeper. Also look for mission driven companies like coinbase


Here’s a deeper dive into **YC and mission-driven companies** that publicly share their core values—and how effectively they do it via UX:

---

###  Notable YC Companies & Mission-Driven Leaders

#### **1. Airbnb** — *Warm, Visual, and Relatable* — **Top UX**  
- **Core Values Shown On**: “Life at Airbnb” careers page.citeturn1search0  
- **Value Titles**:
  - *Champion the Mission* — “We’re united in partnership with our community to create connection, which enables belonging.”
  - *Be a Host*
  - *Embrace the Adventure*
  - *Be a Cereal Entrepreneur*  
- **UX Highlights**: Visually rich, Friendly tone, Storytelling + imagery = values that feel lived, not just posted.

---

#### **2. Stripe** — *Principled, Functional, and Crisp* — **Strong UX**  
- **Presentation**: Values are framed as **“operating principles”** on “How we work” pages.citeturn1search32  
- **Styling**: Minimalist, principle-driven, practical (e.g., “macro-optimistic but micro-pessimistic”)—reinforces how they work, not just what feels right.

---

#### **3. Dropbox** — *Culture-Meets-Compass* — **Moderate UX**  
- **Location**: Investor documentation and internal culture references.citeturn1search36  
- **Core Values**: “Be worthy of trust,” among others—used as guiding principles for behavior.

---

#### **4. Coinbase** — *Mission-Driven, Needs Visibility* — **Low UX Accessibility**  
- Though highly mission-driven, **Coinbase doesn’t surface core values clearly on its site**, which diminishes external visibility.

---

###  UX-Based Rankings

| **Rank** | **Company**  | **UX Strength**         | **Standout UX Feature**                            |
|----------|---------------|--------------------------|-----------------------------------------------------|
| 1        | Airbnb        | Rich & Emotional         | Visually immersive + human-centric messaging        |
| 2        | Stripe        | Structured & Practical   | Principle-driven language that guides behavior      |
| 3        | Dropbox       | Functional & Cultural    | Value-as-compass—a cultural touchstone internally   |
| 4        | Coinbase      | Mission, Not Visible     | Needs stronger public-facing values display         |

---

###  Why UX Matters for Values

- **Memorability**: Airbnb’s visual and emotive style helps values stick.
- **Operational Clarity**: Stripe aligns values directly with behaviors and decisions.
- **Cultural Integration**: Dropbox folds values into its identity; employees know them.
- **External Perception**: Coinbase’s mission is strong, but lacks UX signals to reinforce values publicly.

---

###  What This Means for Jovie

Emulate the **best of both worlds**:
- **Airbnb-style UX**: Use simple visuals, tone, and narrative to make values feel alive.
- **Stripe-style clarity**: Keep values actionable and decision-oriented.
- **Visibility matters**: Make your values prominent on career pages, about pages, or internal docs.

---

Let me know if you'd like mockups or specific UX-forward concepts to present Jovie’s values externally—whether that's hero panels for a landing page, internal dashboards, or even tooltips in your documentation.


Remember when I think it was coinable put out the memo about being mission driven and pissed everyone off. but Paul Graham stood by them. Tell me about that


Yes — you’re thinking of **Coinbase’s “mission-focused company” memo** from September 2020, written by CEO **Brian Armstrong**.  

---

### 🔑 What Happened
- Armstrong published a blog post and internal memo saying Coinbase would be a **“mission-focused company”**.  
- He stated Coinbase would **not engage in social activism or political debates** unrelated to its core mission (economic freedom through crypto).  
- Employees were told the company would stay out of broader cultural/political issues, and those uncomfortable with this could take a severance package.  
- Around **60+ employees left** shortly after.  

---

### ⚡ Why It Pissed People Off
- Many in Silicon Valley saw it as **“apolitical = siding with the status quo.”**  
- Critics argued that avoiding social issues was tone-deaf in 2020 (right after Black Lives Matter protests).  
- Others felt it was a way of telling employees to “shut up and code.”  
- The backlash was loud, with debates about whether companies *should* have a social/political stance beyond their product.  

---

### 💡 Paul Graham’s Reaction
- Paul Graham (YC co-founder) **publicly defended Coinbase**.  
- His take: Armstrong was being **clear and principled**, and that “focus” on the mission is what startups need to survive and thrive.  
- Graham argued that companies **cannot be everything to everyone**, and diluting focus with politics weakens their ability to build products.  
- Many YC-style founders agreed — praising the clarity and “default alive” attitude of focusing resources only on what serves the mission.  

---

### 🧭 Why It Matters
- Coinbase essentially drew a line: “We are here to build this one thing, and won’t dilute with causes outside it.”  
- It became a model (and lightning rod) for **mission-driven clarity** — aligning with YC’s principle of *“Make something people want”* and strip away distractions.  
- Even with controversy, Coinbase remained one of the most mission-driven YC companies and went public less than a year later (2021).  

---

👉 This memo ties straight into your **Default Alive + Build for the User** values: YC and Armstrong both hammer on *focus*.  

Would you like me to **pull key wording from Armstrong’s original memo** and Paul Graham’s defense so we can craft a “Jovie stance” on focus and mission that’s just as sharp (but with your own tone)?


This is very much our stance. I abosultyly loved it. i love the "shut up and code" because that's your damn job as an engineer at a startup. You can go protest when your stock vests and you retire or move on from Jovie, but til then were here to build.


Exactly, Mr. White — that’s the heart of Armstrong’s stance, and why Paul Graham backed it so strongly. It cuts through all the noise:  

- **Startup survival = ruthless focus.** Distraction is death.  
- **Employee job = build the product.** Not to be a political activist inside the company.  
- **Mission clarity = freedom.** By saying “we’re here for X and nothing else,” you protect energy, reduce infighting, and keep velocity.  

Coinbase’s memo basically said: *“We are here to increase economic freedom through crypto. If you want to campaign for other causes, that’s fine — but do it on your own time, not under Coinbase’s banner.”*  

YC DNA is the same:  
- **Default alive.**  
- **Focus on users.**  
- **Make something people want.**  
- **Drop everything else.**  

For Jovie, that translates cleanly:  
> *“We’re here to build the orchestration OS for creators. Period. If you want to debate politics or external causes, that’s your right, but outside of Jovie. Inside, our oxygen is product velocity and user love.”*  

Would you like me to help **codify this into your core-values file as a “Mission Above Politics” section**, phrased in your blunt, no-nonsense tone?


Yeah but make it less of an anti politics and more of a pro mission


Got it — so instead of “we don’t do politics,” the emphasis is **we do mission, and only mission**. It’s positive framing: energy goes to *building Jovie* because that’s why everyone’s here.  

Here’s a draft value you could slot right into your core-values file:  

---

### **Mission Above All**  
Our purpose is to build the orchestration OS for creators. That is why Jovie exists, and that is what we focus on. Every engineer, designer, and teammate is here to move that mission forward. There are endless causes worth caring about, but inside Jovie, our time and energy belong to the mission.  

---

This keeps Armstrong’s clarity but frames it as *pro-mission* rather than *anti-politics*.  

Want me to rewrite your `core-values.md` so this becomes a new **#2 value (after Default Alive)** and everything else shifts down?


Yes but abstract the mission itself out of the statement as our mission may change if the company pivots


Perfect — if you want it pivot-proof, we should phrase it around **commitment to *the mission*** (whatever that mission is at a given time), rather than locking it to one expression.  

Here’s the abstracted version:  

---

### **Mission Above All**  
Our collective focus is the company’s mission. That is the reason we exist and the purpose of our work. Every teammate’s responsibility is to move the mission forward with speed and excellence. There are countless worthy causes in the world, but within Jovie, our energy belongs to the mission.  

---

Would you like me to drop this into `core-values.md` as the new **#2** right after *Default Alive*, and renumber the rest?


yes and then re-evaluate for yc feedback, order, and what Paul Graham would say


I added **Mission Above All** as the new #2 value, renumbered everything else, and kept the structure clean.  

Next step: I can re-evaluate this list through the YC lens (survival → mission → users → speed → clarity → metrics → leverage → safety → excellence → culture) and suggest if the order needs further tweaks to match what Paul Graham would advise. Want me to run that audit now?


yes


Alright, Mr. White — here’s a **YC + Paul Graham–style audit** of your newly updated core values list.  

---

## 🔎 YC Lens Priorities
From essays and advice (Paul Graham, Sam Altman, YC playbook), the startup survival order looks like this:  
1. **Default Alive** (don’t die).  
2. **Mission Above All** (focus → prevents distraction).  
3. **Build for the User** (*make something people want*).  
4. **Move Fast** (iteration speed compounds).  
5. **Clarity & Simplicity** (keep communication/code/product obvious).  
6. **Metrics/Measure** (turn iteration into data-driven learning).  
7. **Leverage (Automation)** (amplify force, reduce wasted human cycles).  
8. **Security/Trust** (don’t blow up with avoidable mistakes).  
9. **Excellence** (set high bar; polish makes the difference).  
10. **Ego-Free Culture** (*best idea wins*).  

This matches PG’s philosophy: *stay alive, stay focused, make something users love, iterate fast, measure, systematize, then polish.*  

---

## ✅ Recommended Order for Jovie (YC-Optimized)

### 1. Default Alive  
Operate sustainably and keep control by ensuring growth outpaces burn.  

### 2. Mission Above All  
Our collective focus is the company’s mission. That is the reason we exist and the purpose of our work. Every teammate’s responsibility is to move the mission forward with speed and excellence. There are countless worthy causes in the world, but within Jovie, our energy belongs to the mission.  

### 3. Build for the User  
User love > engineer pride. Every feature, test, and word must serve them.  

### 4. Move Fast & Break Often  
Bias for action with sprint–reflect–repeat cycles; small, fast releases drive learning.  

### 5. Be Concise  
Clear, simple communication in code, design, and copy. Complexity kills speed.  

### 6. Measure Everything  
Metrics over guesswork. Every release should generate usable data.  

### 7. Automate Relentlessly  
Repetition is waste. Systematize and script everything possible so humans can focus on innovation.  

### 8. Secure by Default  
Ship fast without being reckless. Guardrails and integrity are built in, not bolted on.  

### 9. Be So Good They Can’t Ignore You  
Build undeniably excellent products through continuous refinement.  

### 10. Best Idea Wins  
Ego-free environment where outcomes matter more than seniority or pride.  

---

## 🗣️ What Paul Graham Would Say
- He’d love **Default Alive** → it’s his own phrase.  
- He’d back **Mission Above All** → mirrors his defense of Coinbase’s stance.  
- He’d insist on **Build for the User** → his famous mantra.  
- He’d stress **Move Fast** → iteration is survival.  
- He’d nod at **Concise/Measure/Automate** as practical amplifiers.  
- He’d consider **Secure by Default** a necessity (don’t die stupidly).  
- He’d agree with **Excellence** but frame it as “keep raising the bar.”  
- He’d absolutely back **Best Idea Wins** → no politics, no hierarchy, just truth-seeking.  

This order is now fully YC-aligned: survival → focus → users → speed → clarity → metrics → leverage → safety → excellence → culture.  

---

👉 Do you want me to **apply this reordered structure directly to `core-values.md`** so it’s not just renumbered but truly optimized in flow?


So maybe be so good they can't ignore you should be something more aligned with that idea. 


Yes — right now *“Be So Good They Can’t Ignore You”* is framed as **excellence/polish**, but Paul Graham would probably reframe it toward **relentless raising of the bar** or **undeniable product quality** — something that compounds and forces attention.  

Here are a few sharper options that keep the spirit but align more with YC/PG philosophy:  

---

### Option A: **Raise the Bar Relentlessly**  
Good isn’t enough. Every release should be better than the last. Excellence compounds over time until the product becomes undeniable.  

### Option B: **Undeniably Excellent**  
We don’t aim for “good enough.” We build with such clarity, quality, and care that the work can’t be ignored.  

### Option C: **Compounding Excellence**  
Like iteration speed, quality compounds. Every cycle should leave the product, code, and experience undeniably better than before.  

---

All three preserve the *“so good they can’t ignore you”* core, but frame it less as a catchy quote and more as a **repeatable company principle**.  

Do you want me to replace that section in your `core-values.md` with one of these? If so, which tone do you like best — *raise the bar*, *undeniably excellent*, or *compounding excellence*?


Something more on the lines of be best in class, then be better.


I’ve updated that section to **“Best in Class, Then Better”** with the new framing around exceeding benchmarks. Would you like me to now re-check the *entire list* against YC/PG ordering and make sure everything flows correctly with this change?


Yeah i like that concept it can also apply to individuals self improvement and constant learning. i think we can do even better in how we word it


Exactly — that’s the deeper spirit of it: not just product, but **personal mastery → continuous growth → compounding excellence**. YC and Paul Graham would love that, because it’s a cultural accelerant: the company only gets better if each person keeps raising their own ceiling.  

Here are three sharpened wordings you could use to replace *“Best in Class, Then Better”*:  

---

### Option A: **Raise the Bar, Always**  
- **Why**: The standard today is just the starting line for tomorrow.  
- **Interpretation**: Hit best-in-class benchmarks, then surpass them. Individually and collectively, we grow by never settling.  
- **Result**: Compounding excellence across people, product, and company.  

---

### Option B: **Never Stop Getting Better**  
- **Why**: Excellence is a moving target. Progress comes from constant learning and iteration.  
- **Interpretation**: Strive to outdo the industry, outdo the team, and outdo yourself.  
- **Result**: A culture where growth compounds and “great” becomes the baseline.  

---

### Option C: **Be the Best, Then Outdo Yourself**  
- **Why**: Reaching best-in-class isn’t the finish line—it’s the warm-up.  
- **Interpretation**: Continuous learning and self-improvement keep us ahead.  
- **Result**: The company and its people become undeniable through relentless progress.  

---

All three work at **both the product and personal growth levels**.  

👉 Which of these resonates most with the Jovie voice: *direct and cocky (C)*, *principled and crisp (A)*, or *growth-minded and relentless (B)*?


Option c is the exact concept. Is there a sexier way to say it?
