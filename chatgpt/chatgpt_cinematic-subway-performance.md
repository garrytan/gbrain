---
title: "Cinematic Subway Performance"
type: guide
created: 2026-04-27
updated: 2026-04-27
source: chatgpt-export
conversation_id: 69eff4e4-49f8-83e8-8580-24da18331cb3
message_count: 3
tags: [chatgpt, import, code]
---
# Cinematic Subway Performance

> Conversation ID: 69eff4e4-49f8-83e8-8580-24da18331cb3
> Created: 2026-04-27T23:44:36Z
> Updated: 2026-04-27T23:54:03Z
> Messages: 3

---

## User

generate Editorial photograph of a young indie singer-songwriter performing on a New York City subway platform at night. She is seated on a small amp, holding an acoustic guitar mid-strum, eyes down on the strings, a candid unposed moment. A small open guitar case sits in front of her with a few folded bills and a hand-written cardboard sign that simply reads her stage name. Cinematic 35mm film look, shallow depth of field, soft warm tungsten platform lights bokeh-ing in the background, the train tunnel receding into shadow on her right. Composition is wide rectangular, subject framed left-of-center with deliberate negative space on the right two-thirds (so a phone can compose into that space). Mood: quiet, intimate, hopeful, premium. No text, no logos, no people other than the performer, no overt brand marks, no AI artifacting on the guitar strings or fingers. Photorealistic, magazine-cover quality. 3:2 aspect ratio.


Help me work on the prompt above. I want it to generate a high-quality image we can use on our website, and I want it to be super cinematic. I want the girl sitting on the left third line, and it to be believable that on the right third line there could be a column, and she's far away from the camera, looking to the camera, performing in a leather jacket, standing up. She's got blonde hair, blue eyes, 18% body fat, a sharp jawline, high cheekbones, 30% Swedish, 70% a mix of Dutch and English. She's got charisma, and we see a blurred-out subway. The whole thing is monochrome, done with set design and production design, not with color grading. She's styled in just blacks, grays, and a grayscale color palette, and the columns are black or silver or gray or something. The scene just kind of lacks color generally.

I want it to look very cinematic, almost like a cyberpunk kind of feel. There can be subtle steam or haze that can be felt, with light beams and stuff, and subtle blue, purple, pink tints, but very minimal. It's mostly blacks and stuff, with a decent amount of shadows and vignetting. 

---

## Assistant

Mr. White, I’ll turn this into a production-ready hero-image prompt, tighten the composition, resolve contradictions, and translate non-visual traits into renderable visual cues.

---

## Assistant

Mr. White, use this cleaned-up version:

```text
Editorial cinematic photograph, wide 3:2 landscape composition.

A young adult blonde female indie singer-songwriter performs alone on a New York City subway platform at night. She is standing far from the camera on the left third line, full-body or three-quarter body visible, holding an acoustic guitar mid-strum. She looks directly toward the camera with quiet charisma and a calm, confident expression. Sharp jawline, high cheekbones, blue eyes with subtle catchlights, lean athletic build, Northern European features. Blonde hair slightly tousled, styled naturally.

She wears a black leather jacket, charcoal top, black jeans, and black boots. Her entire styling is black, gray, silver, and graphite. The environment also feels almost monochrome through set design and wardrobe: black metal, silver subway columns, gray concrete, dark tile, gunmetal surfaces, and muted platform details. Very little color in the scene, with only extremely subtle blue, purple, and faint pink practical-light accents.

A small open guitar case sits near her feet with a few folded bills and a blank cardboard sign, with no readable text. A silver subway train is blurred in the background, partially visible with soft motion blur. The train tunnel recedes into shadow on the right side. The right two-thirds of the frame contain deliberate negative space, with a believable dark metal or silver subway column positioned around the right third line, softly out of focus, leaving room for website or phone composition.

Cinematic 35mm film still, premium magazine-cover quality, cyberpunk noir mood, shallow depth of field, soft tungsten subway platform lights, anamorphic bokeh, subtle haze and steam, visible light beams, deep shadows, gentle vignette, realistic film grain, high dynamic range, intimate hopeful mood, believable NYC subway production design, photorealistic, natural skin texture, realistic guitar strings, realistic hands and fingers.

No other people. No logos. No brand marks. No readable text. No AI artifacts. No distorted guitar strings. No malformed hands. No extra fingers. No oversaturated colors. No cartoon look. No glossy CGI look.
```

For an image model that accepts a separate negative prompt, use:

```text
centered subject, close-up portrait, seated performer, looking down, extra people, crowd, readable text, logos, brand names, colorful wardrobe, bright saturated colors, daytime, clean modern station, pop-star glamour pose, fake subway, CGI, illustration, cartoon, plastic skin, warped guitar, broken strings, extra fingers, missing fingers, bad hands, deformed face, over-smoothed skin, harsh flash, low-resolution, blurry subject, cluttered right side, flat lighting
```

Key prompt changes I’d keep:

Use **“young adult”** or **“mid-20s”** so the image reads professional and avoids an unintended teen look.

Use **“lean athletic build”** instead of exact body-fat percentage. Image models usually interpret exact body-fat numbers poorly.

Use **“Northern European features”** instead of ancestry percentages. The visual traits you care about are already covered by blonde hair, blue eyes, sharp jawline, and high cheekbones.

Use **“near-monochrome through set design and wardrobe”** because you specifically want the colorlessness to feel physically designed, rather than applied afterward as a filter.

Use **“subject on left third line, right two-thirds negative space, column around right third line”** to force the layout more explicitly.
