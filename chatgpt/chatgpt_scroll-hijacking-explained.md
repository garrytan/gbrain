---
title: "Scroll Hijacking Explained"
type: note
created: 2026-03-09
updated: 2026-03-09
source: chatgpt-export
conversation_id: 69ae6e28-a9f4-8331-86e8-c2469cd25f13
message_count: 2
tags: [chatgpt, import]
---
# Scroll Hijacking Explained

> Conversation ID: 69ae6e28-a9f4-8331-86e8-c2469cd25f13
> Created: 2026-03-09T06:52:28Z
> Updated: 2026-03-09T06:53:05Z
> Messages: 2

---

## User

scroll hijackin

---

## Assistant

**Scroll hijacking (also called “scrolljacking”)** is a web design technique where a website **overrides the browser’s normal scrolling behavior** and replaces it with custom behavior controlled by the site. citeturn0search3turn0search17  

### What it means in practice
Instead of the page moving exactly with your mouse wheel or trackpad, the site intercepts the scroll input and decides what happens.

Common examples:  
- One scroll moves to the **next full section or slide** instead of continuous scrolling.  
- Scrolling triggers **animations or storytelling sequences**.  
- The page **scrolls horizontally instead of vertically**.  
- The **scroll speed or direction is altered**. citeturn0search3turn0search20  

Example experience:  
- You scroll once → page jumps to the next screen.  
- You scroll slowly → page plays an animation before moving.  

### Why websites use it
Designers sometimes implement it to:  
- Control the **order people see content**.  
- Create **interactive storytelling or product demos**.  
- Show **features step-by-step** with animations. citeturn0search1  

### Why many UX experts dislike it
It breaks a fundamental expectation: **scroll input should directly control page movement**. citeturn0search0turn0search16  

Common issues:  
- Slower navigation and frustration  
- Reduced accessibility (keyboard, assistive tech)  
- Higher bounce rates  
- Potential SEO problems if content becomes harder to crawl citeturn0search14  

### Simple summary
- **Normal scroll:** user controls the page.  
- **Scroll hijacking:** the website takes control of the scroll behavior.

If useful, further explanations can include:  
- common libraries used to implement it (GSAP, fullPage.js)  
- how to detect it on a site  
- ways to disable it locally in the browser.
