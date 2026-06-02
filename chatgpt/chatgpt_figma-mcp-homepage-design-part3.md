
Mr. White, use the following prompt for Claude Code with the Figma MCP.

---

**Prompt for Claude Code (Figma MCP)**

You have access to the **Figma MCP tools** that allow generating and updating Figma designs from the codebase.

### Goal
Recreate the **entire homepage landing page** from the application in **Figma**, ensuring the Figma file **matches the rendered production UI exactly** and uses **proper Figma layout primitives (Auto Layout, components, tokens)**.

### Workflow

1. **Load the homepage**
   - Start the dev server if necessary.
   - Navigate to the homepage route.
   - Wait until **all async data, images, fonts, and scripts finish loading**.
   - Verify there are **no loading skeletons, spinners, or pending network requests** before capturing.

2. **Capture the rendered layout**
   - Extract the **fully rendered DOM layout**, including:
     - spacing
     - typography
     - colors
     - images
     - icons
     - responsive containers
     - grid structure
   - Preserve the **exact visual hierarchy and spacing**.

3. **Send the layout to Figma**
   - Use the **Figma MCP** to create or update a **Homepage Landing Page frame**.
   - Structure the design using proper **Auto Layout** rules:
     - vertical stacks for sections
     - horizontal Auto Layout for rows
     - spacing values matching the code
   - Convert repeated patterns into **components** where appropriate (cards, buttons, nav items, etc.).
   - Use **text styles and color styles** derived from the code tokens.

4. **Ensure design fidelity**
   - Compare the generated Figma frame against the **live rendered page**.
   - Validate:
     - spacing
     - font sizes
     - line heights
     - alignment
     - responsive containers
     - icon sizes
     - image aspect ratios

5. **Iterate until parity**
   - If discrepancies exist, **update the Figma layout programmatically**.
   - Repeat the compare → update loop until the Figma design **visually matches the site pixel-for-pixel**.

6. **Design quality rules**
   - Every container must use **Auto Layout**.
   - Avoid absolute positioning unless required for overlays.
   - Maintain proper **component nesting and constraints**.
   - Ensure the file structure is clean:
     - `Homepage`
       - `Navbar`
       - `Hero`
       - `Feature Sections`
       - `Content Blocks`
       - `Footer`

7. **Final validation**
   - Confirm:
     - All sections exist
     - No layout drift
     - Auto Layout works when resizing
     - Components are reusable
     - Typography styles are consistent

### Deliverable
A **fully structured Figma page** that mirrors the homepage exactly and follows best practices for:
- Auto Layout
- reusable components
- proper spacing tokens
- maintainable design structure.

---

If useful, this can also be upgraded into a **fully autonomous Claude Code agent prompt** that:
1. boots the dev server  
2. screenshots sections  
3. builds the Figma file section-by-section  
4. performs visual diffing against the site.


**Topic:** [[chatgpt-clusters/design_ux]]
