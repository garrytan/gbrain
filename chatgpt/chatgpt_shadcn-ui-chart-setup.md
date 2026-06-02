---
title: "Shadcn UI chart setup"
type: note
created: 2025-11-08
updated: 2025-11-08
source: chatgpt-export
conversation_id: 690fc3e8-f258-832e-8d00-83f3a80fe3c7
message_count: 2
tags: [chatgpt, import, code]
---
# Shadcn UI chart setup

> Conversation ID: 690fc3e8-f258-832e-8d00-83f3a80fe3c7
> Created: 2025-11-08T22:27:58Z
> Updated: 2025-11-08T22:29:13Z
> Messages: 2

---

## User

shadecn ui chart

---

## Assistant

Here’s an overview of how to use the chart components in entity["software", "shadcn/ui", 0] (for React) — Mr. White:

image_group{"layout":"bento","aspect_ratio":"1:1","query":["shadcn ui chart example bar chart","shadcn ui chart theming css variables","shadcn ui chart tooltip legend example"],"num_per_query":1}

---

### ✅ What it is  
- shadcn/ui’s Charts are built on top of entity["software", "Recharts", 0]. citeturn0search0turn0search14turn0search13  
- They aim to be “copy-and-paste into your apps” components with styling that matches shadcn/ui design and Tailwind. citeturn0search1turn0search3  
- They support multiple chart types: bar, area, pie, radar, etc. citeturn0search12  

---

### 🛠️ How to get started  
1. **Install the chart component**  
   ```bash
   npx shadcn@latest add chart
   ```  
   citeturn0search0turn0search13  

2. **Define your data & config**  
   Example:  
   ```ts
   const chartData = [
     { month: "January", desktop: 186, mobile: 80 },
     { month: "February", desktop: 305, mobile: 200 },
     // ...
   ];

   const chartConfig = {
     desktop: { label: "Desktop", color: "#2563eb" },
     mobile: { label: "Mobile", color: "#60a5fa" },
   } satisfies ChartConfig;
   ```  
   citeturn0search0turn0search13  

3. **Use the `ChartContainer` and Recharts components**  
   ```tsx
   <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
     <BarChart accessibilityLayer data={chartData}>
       <CartesianGrid vertical={false} />
       <XAxis dataKey="month" tickLine={false} axisLine={false} />
       <ChartTooltip content={<ChartTooltipContent />} />
       <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
       <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
     </BarChart>
   </ChartContainer>
   ```  
   citeturn0search0turn0search13  

4. **Theming & CSS variables**  
   Use CSS variables so your charts respond to light/dark themes. Example from docs:  
   ```css
   :root {
     --chart-1: oklch(0.646 0.222 41.116);
     --chart-2: oklch(0.6 0.118 184.704);
     /* … */
   }

   .dark {
     --chart-1: oklch(0.488 0.243 264.376);
     --chart-2: oklch(0.696 0.17 162.48);
   }
   ```  
   citeturn0search0turn0search13  

---

### ⚠️ Things to be aware of  
- Since charts are built on Recharts, you still need to understand Recharts fundamentals (data format, `dataKey`, axes, grid, etc).  
- Accessibility: There is built-in support via `accessibilityLayer`, but you should review accessibility if your app has strong requirements. citeturn0search17  
- Customization: While the out-of-box styles look good, for more advanced custom charts you’ll need to mix in Recharts props and possibly custom components (tooltip, legend) yourself.  
- Dependency version: The docs note they’re working on upgrading to Recharts v3. citeturn0search0  

---

If you like, Mr. White, I can pull in **code snippets** for different chart types (bar, line, pie, radar) using shadcn/ui so you can pick one and adapt it in your project. Would that be helpful?
