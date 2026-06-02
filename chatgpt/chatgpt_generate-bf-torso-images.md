---
title: "Generate BF% torso images"
type: guide
created: 2025-11-04
updated: 2025-11-04
source: chatgpt-export
conversation_id: 690a9042-ca28-832c-bd74-75a5ad553ef9
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# Generate BF% torso images

> Conversation ID: 690a9042-ca28-832c-bd74-75a5ad553ef9
> Created: 2025-11-04T23:48:37Z
> Updated: 2025-11-04T23:53:30Z
> Messages: 10

---

## User

I need to generate a set of images of a male torso at various BF%. It should be 5-50% BF with logical resolution gaps like 8-10-12-14-15-20-25-30-40 etc, or whatever makes sense given likliehood of someone being that and also the difference visually (higher bf requires less resoltuion because changes are more subtle etc).

Whats the best method to do this? Can i get dall-e or other AI Tools to do it?
The images need to be white wireframe on black showing only the torso in a futurist HUD like animation.
I need them to all be identical except for the BF% represented.


---

## Assistant

Yes — this can absolutely be done using modern AI image generation tools like **DALL·E 3**, **Midjourney**, or **Stable Diffusion**, with some extra control steps to keep all images identical except for the body fat (BF%) representation. Here’s the most reliable approach:

---

### **1. Define the visual baseline**
First, generate a **base torso** image with the desired style:
- “White wireframe male torso on black background, futuristic HUD style, front view, no arms or head.”
- High-resolution (e.g., 1024×1024).
- Choose a muscular but neutral physique (around 15% BF).

This becomes your **template image**.

---

### **2. Generate variations by BF%**
To ensure consistency:
- Use **image-to-image generation** (in DALL·E 3 or Stable Diffusion’s “img2img” mode) with a **low variation strength** (e.g., 0.2–0.4).
- Provide the same prompt each time, changing only the BF% descriptor, e.g.:

  > “White wireframe male torso, 10% body fat, futuristic HUD schematic, identical pose and proportions.”

  > “White wireframe male torso, 25% body fat, futuristic HUD schematic, identical pose.”

- This ensures only fat distribution and definition change, not lighting, posture, or proportions.

DALL·E can manage this through **image editing** with a mask-free prompt, while Stable Diffusion or Automatic1111 gives more granular control (seed locking, denoising strength, control nets).

---

### **3. Recommended body fat intervals**
Use smaller intervals in the athletic range (where differences are more visually meaningful):

| Category | BF% Values | Notes |
|-----------|-------------|-------|
| Very lean | 5%, 8%, 10%, 12% | Sharp definition changes |
| Fit / average | 14%, 15%, 18%, 20% | Softer abs, more variance |
| Overweight | 25%, 30%, 35%, 40% | Larger increments fine |
| Obese | 45%, 50% | Visual difference smaller |

This gives you about 12–14 images total, covering the practical spectrum.

---

### **4. Tool comparison**
| Tool | Pros | Cons |
|------|------|------|
| **DALL·E 3** | Easy to use, clean results, consistent style with careful prompting | Limited control over seed and fine details |
| **Stable Diffusion + ControlNet** | Maximum control (same pose, lighting, seed) | Requires local setup or API; more technical |
| **Midjourney** | Excellent visual quality | Hard to keep all images identical across iterations |

For your use case (futuristic HUD wireframe consistency), **Stable Diffusion with ControlNet** is best — it lets you lock the base pose and structure, then adjust body composition while maintaining identical geometry.

---

### **5. Optional animation**
Once you have the static images, you can use a video interpolation tool (like **Deforum**, **Runway**, or **EbSynth**) to create a smooth HUD-style animation transitioning through BF% values.

---

Would you like me to draft the **exact prompts** (for DALL·E and Stable Diffusion) to generate these images with consistent style and labeling?

---

## User

yes

---

## Assistant

Excellent. Below are **prompt templates and workflow details** for both **DALL·E 3** and **Stable Diffusion (with ControlNet)** — optimized for your use case: a consistent white wireframe male torso on black background, varying only by BF%.  

---

## **1. DALL·E 3 Workflow**

### **Base Image Prompt**
Use this first to establish your “template”:
> “Front view of a male torso only (no head, no arms), shown as a detailed white wireframe on a black background, futuristic HUD interface style, symmetrical proportions, no text or numbers.”

When you’re satisfied with the visual baseline, **download that image** — this becomes your master reference.

---

### **BF% Variation Prompts**
Then use DALL·E’s **“Edit this image”** or **“Generate variations”** feature. Keep the same image uploaded, and for each version, use:

> “Identical image of the male torso in the same pose and wireframe style, but representing **[X]% body fat** — adjust body proportions and definition accordingly.”

Replace **[X]** with:
```
5, 8, 10, 12, 14, 15, 18, 20, 25, 30, 35, 40, 45, 50
```

- Keep the “identical image” wording — it helps DALL·E preserve the layout.
- You can manually adjust sharpness afterward if some variants differ slightly in brightness or contrast.

---

## **2. Stable Diffusion + ControlNet (preferred for precision)**

If you’re comfortable using **Automatic1111**, **ComfyUI**, or a hosted service (like Mage.Space or Leonardo.Ai with ControlNet support), follow this approach.

### **Base Image Prompt**
> “White wireframe male torso, front view, on black background, symmetrical pose, futuristic HUD schematic aesthetic, no arms or head, no text, consistent camera and lighting.”

Save that base image.

---

### **Parameters for consistency**
- **Sampler:** DPM++ 2M Karras  
- **Seed:** fixed (e.g., 12345 — use the same seed for all generations)  
- **Denoising strength:** 0.25–0.35  
- **CFG Scale:** 7–8  
- **Resolution:** 1024×1024  
- **ControlNet model:** Canny or OpenPose (locks outline or pose of the torso)  
- **Input:** your base image  

---

### **BF% Variation Prompts**
> “White wireframe male torso on black background, futuristic HUD schematic, identical camera and pose, representing **[X]% body fat** — realistic anatomical adjustments, subtle wireframe shape change according to body fat distribution.”

You can include optional descriptors for realism:
> “At lower body fat levels (5–12%), show sharper ab definition and visible muscle striations.  
At higher body fat levels (25–50%), reduce muscle visibility and increase smoothness of outline.”

Use the same prompt for each variation, just swapping the % value.

---

## **3. Optional Labeling or Animation**

Once images are generated:
- Use **ImageMagick** or **After Effects** to overlay text like “15% BF” unobtrusively.
- For animation, **Deforum Stable Diffusion** or **Runway** can interpolate between frames to create a smooth morph through all BF% levels.

---

Would you like me to produce the *exact full prompt list (ready to copy-paste)* for every BF% value (5–50%) in both DALL·E and Stable Diffusion formats? I can make them standardized and batch-ready.

---

## User

Give me full dall e prompt

---

## Assistant

Here’s the **full master prompt** for DALL·E 3 — structured to produce consistent, high-fidelity images of a male torso in a futuristic wireframe style. You’ll use the same base phrasing, only changing the **body fat percentage** each time.  

---

## **Full DALL·E 3 Prompt Template**

> **Prompt:**
> “Front view of a **male human torso only** (no head, no arms), shown as a **precise white wireframe render on a solid black background**, designed in a **futuristic HUD / digital schematic style**. The figure is perfectly symmetrical, evenly lit, and centered in frame.  
>  
> The wireframe lines should clearly define the chest, abs, and waist contours appropriate for **[X]% body fat**, with anatomical accuracy.  
>  
> Maintain identical camera angle, proportions, line weight, background, and visual style across all versions. No text, no numbers, no logos, no additional graphics — only the torso wireframe.”

---

### **BF% Values to Generate**
Use the same prompt with the following substitutions for **[X]**:

```
5
8
10
12
14
15
18
20
25
30
35
40
45
50
```

---

### **Usage Tips**
1. Generate the **first image at 15% BF** — use that as your baseline.  
2. For each subsequent percentage, **upload that same image into DALL·E** and choose *Edit image* → *Replace description* with the new prompt (“identical image representing X% body fat”).  
3. DALL·E will preserve composition while adjusting body contours.  
4. Keep the **same aspect ratio** (1:1 or 4:5) for uniform comparison.  
5. Once complete, you can label or animate them externally (e.g., After Effects, Runway, or Figma).

---

Would you like me to extend this into a **ready-to-paste batch list** (one line per BF%) so you can drop them directly into DALL·E with minimal edits?

---

## User

yes

---

## Assistant

Here’s the **ready-to-paste full prompt set** — one for each body fat percentage.  
Each line is independent and can be directly copied into DALL·E 3 as-is.  

---

### ✅ **DALL·E 3 Prompts for Male Torso Wireframe Series (5–50% BF)**

**5% BF**  
> Front view of a male human torso only (no head, no arms), shown as a precise white wireframe render on a solid black background, designed in a futuristic HUD / digital schematic style. The figure is perfectly symmetrical, evenly lit, and centered in frame. The wireframe lines clearly define the chest, abs, and waist contours appropriate for **5% body fat**, showing extreme muscle definition and vascularity. Maintain identical camera angle, proportions, line weight, and background across all versions. No text or numbers.

**8% BF**  
> Front view of a male human torso only (no head, no arms), shown as a precise white wireframe render on a solid black background, futuristic HUD schematic style. Identical camera and proportions. The torso represents **8% body fat**, with visible ab segmentation and sharp muscle definition. No text or numbers.

**10% BF**  
> Front view of a male human torso only (no head, no arms), rendered as a white wireframe on black background in a futuristic HUD schematic style. Identical framing and symmetry. Represents **10% body fat**, showing defined muscles with moderate vascularity. No text or numbers.

**12% BF**  
> White wireframe front-view male torso on black background, futuristic HUD schematic, identical to other versions. Represents **12% body fat**, slight softening of abs and reduced vascularity, still athletic appearance. No text or numbers.

**14% BF**  
> White wireframe front-view male torso, futuristic HUD schematic on black background, same composition and proportions. Represents **14% body fat**, mild smoothing of muscular contours, lean but not shredded. No text or numbers.

**15% BF**  
> Front-view male torso only (no head or arms), white wireframe on black background, futuristic HUD schematic. Identical proportions and pose. Represents **15% body fat**, typical athletic build with mild ab definition. No text or numbers.

**18% BF**  
> White wireframe male torso, front view, on black background, futuristic HUD schematic style, identical to other versions. Represents **18% body fat**, moderate softness, abs barely visible. No text or numbers.

**20% BF**  
> Front-view male torso, white wireframe, black background, futuristic schematic style. Identical composition. Represents **20% body fat**, smooth contours, minimal ab definition, natural physique. No text or numbers.

**25% BF**  
> White wireframe male torso, same front view and proportions, on black background in futuristic HUD style. Represents **25% body fat**, visible fullness in midsection, smooth outline, less definition. No text or numbers.

**30% BF**  
> Front-view male torso, white wireframe render on black background, identical pose and scale. Represents **30% body fat**, increased abdominal and chest roundness, reduced muscular contour. No text or numbers.

**35% BF**  
> White wireframe male torso, futuristic HUD schematic, identical framing and composition on black background. Represents **35% body fat**, rounder midsection and chest, soft overall outline. No text or numbers.

**40% BF**  
> White wireframe male torso, futuristic HUD schematic, same camera angle and proportions on black background. Represents **40% body fat**, noticeable fullness in abdomen and chest, smooth contours. No text or numbers.

**45% BF**  
> White wireframe male torso, identical pose and perspective, futuristic HUD schematic style on black background. Represents **45% body fat**, significant roundness and lack of muscular definition. No text or numbers.

**50% BF**  
> White wireframe male torso, futuristic HUD schematic, identical framing on black background. Represents **50% body fat**, very smooth and rounded torso shape with no visible muscle structure. No text or numbers.

---

Would you like me to make a **compressed version** of these (short, one-line per prompt) for bulk upload or automation through an API or script?

---

## User

yes

---

## Assistant

Mr. White — here are the **compressed, one-line DALL·E prompts** for each BF% (ready to paste). After that, you’ll find downloadable CSV and JSONL files for bulk runs.

### One-liners (5–50% BF)
- **5%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 5% body fat with anatomically accurate contours; no text, numbers, or logos.
- **8%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 8% body fat with anatomically accurate contours; no text, numbers, or logos.
- **10%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 10% body fat with anatomically accurate contours; no text, numbers, or logos.
- **12%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 12% body fat with anatomically accurate contours; no text, numbers, or logos.
- **14%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 14% body fat with anatomically accurate contours; no text, numbers, or logos.
- **15%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 15% body fat with anatomically accurate contours; no text, numbers, or logos.
- **18%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 18% body fat with anatomically accurate contours; no text, numbers, or logos.
- **20%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 20% body fat with anatomically accurate contours; no text, numbers, or logos.
- **25%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 25% body fat with anatomically accurate contours; no text, numbers, or logos.
- **30%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 30% body fat with anatomically accurate contours; no text, numbers, or logos.
- **35%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 35% body fat with anatomically accurate contours; no text, numbers, or logos.
- **40%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 40% body fat with anatomically accurate contours; no text, numbers, or logos.
- **45%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 45% body fat with anatomically accurate contours; no text, numbers, or logos.
- **50%** — Front view of a male human torso only (no head, no arms), precise white wireframe on solid black, futuristic HUD schematic style, perfectly symmetrical and centered, identical camera/scale/style across versions, representing 50% body fat with anatomically accurate contours; no text, numbers, or logos.

### Bulk files
- [Download the CSV](sandbox:/mnt/data/torso_prompts.csv)
- [Download the JSONL](sandbox:/mnt/data/torso_prompts.jsonl)

If you want, I can also generate a **version with explicit “Use the uploaded base image; identical composition”** phrasing for DALL·E’s *Edit image* flow, or a **Stable Diffusion batch** with seed/CFG/denoise settings embedded.
