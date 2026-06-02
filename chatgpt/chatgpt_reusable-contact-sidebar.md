---
title: "Reusable contact sidebar"
type: essay
created: 2025-11-30
updated: 2025-11-30
source: chatgpt-export
conversation_id: 692c87e8-c5ec-8329-b125-94b995497cf4
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Reusable contact sidebar

> Conversation ID: 692c87e8-c5ec-8329-b125-94b995497cf4
> Created: 2025-11-30T18:07:37Z
> Updated: 2025-11-30T18:12:42Z
> Messages: 4

---

## User

I'm in the panel right now. We have a table of creators for our user page and what I would like to do is I'd like to build a reusable component that is basically a contact component and basically the way I want this to work is we're gonna make the table so that if you click on a profile in the table a single time you select that row and then if you hit the spacebar a sidebar will slide out from the right and it should push the content over it shouldn't overlay over it it should actually push the content over and and that sidebar should have a clean a clean avatar using our existing avatar component right there that is editable so if you click on it you can upload and change the avatar it should have first name last name user name inputs and then it should have social icons and a plus button where I can click the plus button and an input pops up to enter a new social link and that and then when you hit enter it saves that and then populates the new social link and then has a that could be it for now I mean eventually we'll add the ability to do like music DSPs and stuff and so for now this will be in the existing the admin panel so that an admin can click on any profile and just change like the person's name or change like some quick info real quick to edit it but we'll also probably use this in the future to be like in the customer CRM so when you can see all the fans that like pre-saved your link or sign up to notifications and stuff we'll use this and so we want an editable mode on editable mode hmm and we want it to be nice and clean and like all the labels in line and stuff and have it you know be like I don't know like 300 pixels wide or something like that maybe 360 pixels whatever but have it be nice and clean modern and based off of the shads and primitives and everything and fitting all of our guardrails

---

## Assistant

Here’s one way to build this out as a reusable “contact sidebar” that:

- Opens with **Space** when a row is selected  
- **Pushes** the table content (not overlay)  
- Uses shadcn primitives + your existing Avatar  
- Has editable fields + social links with a “+” flow  
- Can support `view` vs `edit` later via a `mode` prop  

I’ll give you:

1. Layout wiring (table + sidebar + spacebar behavior)  
2. `ContactSidebar` component (reusable + clean + modern)

---

## 1. Layout wiring: table + sidebar + spacebar

```tsx
// app/(admin)/creators/page.tsx (example)
"use client";

import * as React from "react";
import { ContactSidebar, Contact } from "@/components/contact-sidebar";

type Creator = Contact; // or extend Contact with your own fields

export function CreatorsPage() {
  const [selected, setSelected] = React.useState<Creator | null>(null);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // SPACE toggles sidebar when a row is selected
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selected) return;

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }

      if (e.key === "Escape") {
        setSidebarOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  // Example: you’ll replace CreatorsTable with your real table
  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex-1 overflow-auto">
        <CreatorsTable
          selectedId={selected?.id}
          onRowClick={(creator: Creator) => {
            setSelected(creator);
            // single click just selects row; SPACE actually opens sidebar
          }}
        />
      </div>

      <ContactSidebar
        open={sidebarOpen && !!selected}
        contact={selected}
        mode="edit" // or "view" later for CRM
        onClose={() => setSidebarOpen(false)}
        onChange={(updated) => {
          // sync with table / server
          setSelected(updated);
          // you’ll probably also push this up to parent/store
        }}
      />
    </div>
  );
}

// Dummy table for illustration
function CreatorsTable({
  selectedId,
  onRowClick,
}: {
  selectedId?: string;
  onRowClick: (c: Creator) => void;
}) {
  const data: Creator[] = []; // your real data
  return (
    <table className="w-full text-sm">
      <tbody>
        {data.map((creator) => (
          <tr
            key={creator.id}
            onClick={() => onRowClick(creator)}
            className={`cursor-pointer border-b transition-colors ${
              selectedId === creator.id ? "bg-muted" : "hover:bg-muted/60"
            }`}
          >
            <td className="px-4 py-2">{creator.firstName}</td>
            <td className="px-4 py-2">{creator.lastName}</td>
            <td className="px-4 py-2 text-muted-foreground">
              @{creator.username}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Key bit for **push, not overlay** is the `flex` layout and letting the sidebar have a real width.

---

## 2. Reusable `ContactSidebar` component

- Width animates from `0` → `360px` so it **slides in and pushes** the table.  
- Uses a two-column grid: labels left, inputs right (clean inline labels).  
- Avatar is clickable → hidden file input → calls `onAvatarChange`.  
- Social links: list + "+" button → inline input → Enter to add.  

```tsx
// components/contact-sidebar.tsx
"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Plus, X, ExternalLink, Edit2, Save } from "lucide-react";

// Use your existing Avatar component here
// import { Avatar } from "@/components/avatar";

export type SocialLink = {
  id: string;
  label: string;
  url: string;
};

export type Contact = {
  id: string;
  avatarUrl?: string | null;
  firstName: string;
  lastName: string;
  username: string;
  socials: SocialLink[];
};

type Mode = "view" | "edit";

interface ContactSidebarProps {
  open: boolean;
  contact: Contact | null;
  mode?: Mode; // "edit" for admin panel, "view" for CRM later
  onClose?: () => void;
  onChange?: (contact: Contact) => void;
  onSave?: (contact: Contact) => void; // server save hook
}

export function ContactSidebar({
  open,
  contact,
  mode: modeProp = "edit",
  onClose,
  onChange,
  onSave,
}: ContactSidebarProps) {
  const [local, setLocal] = React.useState<Contact | null>(contact);
  const [mode, setMode] = React.useState<Mode>(modeProp);
  const [isAddingSocial, setIsAddingSocial] = React.useState(false);
  const [newSocialLabel, setNewSocialLabel] = React.useState("");
  const [newSocialUrl, setNewSocialUrl] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setLocal(contact);
  }, [contact]);

  React.useEffect(() => {
    setMode(modeProp);
  }, [modeProp]);

  if (!contact && !local) {
    // keep the width animation but show nothing inside if no row is selected
    return (
      <div
        className={cn(
          "h-full overflow-hidden border-l bg-background transition-[width] duration-300 ease-out",
          open ? "w-[360px]" : "w-0"
        )}
      />
    );
  }

  const current = local ?? contact!;
  const isEditable = mode === "edit";

  function patch(next: Partial<Contact>) {
    const updated = { ...current, ...next };
    setLocal(updated);
    onChange?.(updated);
  }

  function updateSocials(updater: (socials: SocialLink[]) => SocialLink[]) {
    const updated = { ...current, socials: updater(current.socials ?? []) };
    setLocal(updated);
    onChange?.(updated);
  }

  function handleAvatarClick() {
    if (!isEditable) return;
    fileInputRef.current?.click();
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // You can swap this for an upload flow.
    const url = URL.createObjectURL(file);
    patch({ avatarUrl: url });
  }

  function handleAddSocial() {
    if (!newSocialUrl.trim()) return;

    const id = crypto.randomUUID?.() ?? String(Date.now());
    updateSocials((prev) => [
      ...prev,
      {
        id,
        label: newSocialLabel.trim() || newSocialUrl.trim(),
        url: newSocialUrl.trim(),
      },
    ]);

    setNewSocialLabel("");
    setNewSocialUrl("");
    setIsAddingSocial(false);
  }

  function handleSave() {
    if (!local) return;
    onSave?.(local);
    // if the parent doesn't control mode, you could also setMode("view") here
  }

  return (
    <div
      className={cn(
        "h-full overflow-hidden border-l bg-background transition-[width] duration-300 ease-out",
        open ? "w-[360px]" : "w-0"
      )}
    >
      <div
        className={cn(
          "flex h-full flex-col transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <Card className="flex h-full flex-col rounded-none border-0">
          <CardHeader className="flex flex-row items-center justify-between gap-2 border-b">
            <div className="space-y-0.5">
              <CardTitle className="text-base font-semibold">
                {current.firstName || current.lastName
                  ? `${current.firstName} ${current.lastName}`.trim()
                  : "Contact"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                @{current.username || "username"}
              </p>
            </div>

            <div className="flex items-center gap-1">
              {isEditable ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={handleSave}
                  title="Save"
                >
                  <Save className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => setMode("edit")}
                  title="Edit"
                >
                  <Edit2 className="h-4 w-4" />
                </Button>
              )}

              {onClose && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={onClose}
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </CardHeader>

          <ScrollArea className="flex-1">
            <CardContent className="space-y-6 py-4">
              {/* Avatar */}
              <section className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleAvatarClick}
                  disabled={!isEditable}
                  className="group relative rounded-full border bg-muted/40 p-1 transition hover:bg-muted"
                >
                  {/* Replace with your Avatar */}
                  <div className="relative h-20 w-20 overflow-hidden rounded-full">
                    {/* 
                      <Avatar src={current.avatarUrl ?? undefined} />
                    */}
                    {current.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={current.avatarUrl}
                        alt={current.username}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-sm font-semibold">
                        {current.firstName?.[0] ?? current.lastName?.[0] ?? "?"}
                      </div>
                    )}
                    {isEditable && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white opacity-0 transition group-hover:opacity-100">
                        Change
                      </div>
                    )}
                  </div>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarChange}
                />
              </section>

              <Separator />

              {/* Core fields */}
              <section className="space-y-4">
                <FieldGrid>
                  <FieldRow label="First name">
                    <Input
                      value={current.firstName}
                      onChange={(e) =>
                        isEditable && patch({ firstName: e.target.value })
                      }
                      disabled={!isEditable}
                      placeholder="First name"
                    />
                  </FieldRow>

                  <FieldRow label="Last name">
                    <Input
                      value={current.lastName}
                      onChange={(e) =>
                        isEditable && patch({ lastName: e.target.value })
                      }
                      disabled={!isEditable}
                      placeholder="Last name"
                    />
                  </FieldRow>

                  <FieldRow label="Username">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">@</span>
                      <Input
                        value={current.username}
                        onChange={(e) =>
                          isEditable && patch({ username: e.target.value })
                        }
                        disabled={!isEditable}
                        placeholder="username"
                      />
                    </div>
                  </FieldRow>
                </FieldGrid>
              </section>

              <Separator />

              {/* Socials */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Social links
                  </Label>
                  {isEditable && (
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => setIsAddingSocial((v) => !v)}
                    >
                      <Plus className="h-3 w-3" />
                    </Button>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {(current.socials ?? []).map((social) => (
                    <Badge
                      key={social.id}
                      variant="secondary"
                      className="flex items-center gap-1 px-2 py-1 text-xs"
                    >
                      <ExternalLink className="h-3 w-3" />
                      <a
                        href={social.url}
                        target="_blank"
                        rel="noreferrer"
                        className="max-w-[160px] truncate underline-offset-2 hover:underline"
                      >
                        {social.label}
                      </a>
                      {isEditable && (
                        <button
                          type="button"
                          onClick={() =>
                            updateSocials((prev) =>
                              prev.filter((s) => s.id !== social.id)
                            )
                          }
                          className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </Badge>
                  ))}

                  {current.socials?.length === 0 && !isAddingSocial && (
                    <p className="text-xs text-muted-foreground">
                      No social links yet.
                    </p>
                  )}
                </div>

                {isEditable && isAddingSocial && (
                  <div className="space-y-2 rounded-md border bg-muted/40 p-2">
                    <FieldGrid>
                      <FieldRow label="Label">
                        <Input
                          value={newSocialLabel}
                          onChange={(e) => setNewSocialLabel(e.target.value)}
                          placeholder="e.g. Instagram"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddSocial();
                            }
                          }}
                        />
                      </FieldRow>
                      <FieldRow label="URL">
                        <Input
                          value={newSocialUrl}
                          onChange={(e) => setNewSocialUrl(e.target.value)}
                          placeholder="https://..."
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleAddSocial();
                            }
                          }}
                        />
                      </FieldRow>
                    </FieldGrid>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setIsAddingSocial(false);
                          setNewSocialLabel("");
                          setNewSocialUrl("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={handleAddSocial}
                        disabled={!newSocialUrl.trim()}
                      >
                        Add
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* Future: DSPs, etc. */}
            </CardContent>
          </ScrollArea>
        </Card>
      </div>
    </div>
  );
}

/** Inline label layout helper */

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm">
      {children}
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <div>{children}</div>
    </>
  );
}
```

### How this fits your requirements

- **Single-click row** → only selects in state.  
- **Spacebar** → toggles `open` on the sidebar for the selected row.  
- **Push, don’t overlay** → flex layout + `w-[360px]` animated from `0` in the sidebar.  
- **Avatar** → uses your existing component; click → upload.  
- **First / last / username** → inline labels via the `FieldGrid`/`FieldRow` helpers.  
- **Social icons + + button** → shown as badges; new link input appears on “+” and saves on Enter.  
- **Reusable** → `ContactSidebar` only cares about a generic `Contact` and `mode`, so you can reuse it both:
  - in the **admin panel** (always `mode="edit"`), and  
  - later in a **CRM** (`mode="view"` with a small “Edit” action).

If you paste this into your codebase, you should mainly need to:

- Swap the dummy `Avatar` implementation for your real Avatar component.  
- Wire up `onSave` to your API.  
- Replace the example `CreatorsTable` with your real table, keeping the `selected` + `SPACE` flow.  

If you want, Mr. White, I can next help you adapt this to your exact table implementation (e.g. TanStack table / shadcn data-table).

---

## User

I don't need all the coding examples because it has the context of our codebase and I prefer that it decides that and not the code. I just want the evals set and the description of what it is.

---

## Assistant

Gotcha, Mr. White — no implementation, just what this thing *is* and how to eval it.

---

## Feature: Contact Sidebar / Contact Detail Panel

**High-level description**

A reusable, right-side **contact detail sidebar** that:

- Is driven by a selected row in the creators/users table.
- Opens when there is a selected row and the user hits **Space**.
- **Pushes** the main content area left (no overlay), with a fixed width ~300–360px.
- Shows an **editable avatar** (using the existing Avatar component).
- Shows **First Name, Last Name, Username** with clean, inline labels.
- Shows **social links** as icon+label chips, with a **“+”** flow:
  - Click `+` → inline inputs appear for label + URL.
  - Press Enter or confirm → link is added to the list.
- Has a concept of **mode**:
  - `edit` mode for admins (fields and avatar editable, social links add/remove).
  - `view` mode for CRM/read-only contexts (no editing, but same layout).
- Is visually aligned with existing **shadcn primitives / design guardrails**.

---

## Eval Set

Below is an eval set you can plug into whatever system is generating/writing the component. Each item is phrased as *behavioral expectations*.

### 1. Selection & Spacebar Interaction

1. **Row Selection Only on Click**
   - **Description:** Single-clicking a row in the creators table **selects** that row but does *not* automatically open the sidebar.
   - **Acceptance:** After clicking a row, selection state is updated (e.g., highlighted row), but the sidebar remains closed until Space is pressed.

2. **Spacebar Opens Sidebar for Selected Row**
   - **Description:** When a row is selected and the user presses **Space**, the contact sidebar opens for that selected person.
   - **Acceptance:** On Space keydown:
     - Sidebar becomes visible.
     - Content reflects the selected row’s data.

3. **Spacebar Toggles Open/Close**
   - **Description:** Pressing Space again while the sidebar is open toggles it closed (if a row is still selected).
   - **Acceptance:** With a row selected and sidebar open, Space closes it; pressing Space again reopens it.

4. **Escape Closes Sidebar**
   - **Description:** Pressing **Esc** closes the sidebar without affecting row selection.
   - **Acceptance:** Row stays selected, sidebar closes.

---

### 2. Layout & Push Behavior

5. **Sidebar Pushes Content, Does Not Overlay**
   - **Description:** The sidebar opens from the right and **pushes** the main content left using layout (flex/grid), not an overlay.
   - **Acceptance:** When sidebar is open:
     - Main table/content width shrinks accordingly.
     - No content is obscured by a floating overlay.

6. **Fixed Width & Responsive Behavior**
   - **Description:** Sidebar has a fixed width in the ~300–360px range and behaves responsibly on smaller screens.
   - **Acceptance:** Width stays within that range on desktop; on smaller widths, layout still works (no clipping/overflow disasters).

7. **Smooth Open/Close Transition**
   - **Description:** Sidebar opening/closing is animated (e.g., width transition), with no jarring layout jumps.
   - **Acceptance:** Open/close is visually smooth; no layout tearing, flicker, or full re-renders of the table.

---

### 3. Avatar Behavior

8. **Avatar Uses Existing Avatar Component**
   - **Description:** The avatar shown in the sidebar is based on the existing Avatar primitive used elsewhere in the product.
   - **Acceptance:** Styling, fallback behavior, and interaction match the platform’s Avatar.

9. **Avatar Editable in Edit Mode Only**
   - **Description:** Clicking the avatar to upload/change only works in `edit` mode; read-only in `view` mode.
   - **Acceptance:**
     - In `edit` mode: clicking avatar opens file picker and updates the avatar image.
     - In `view` mode: avatar is not clickable (or click does nothing).

10. **Avatar Change Persists in Contact Data**
    - **Description:** After changing the avatar, the new image URL/identifier is reflected in the contact’s data and can round-trip through your model/API.
    - **Acceptance:** On save/re-fetch, the updated avatar is still shown for that contact.

---

### 4. Core Fields: Name & Username

11. **Inline Label Layout**
    - **Description:** First Name, Last Name, and Username use a compact, inline label style (label and input aligned in a two-column layout).
    - **Acceptance:** Labels are visually aligned in one column; inputs in another; looks structured/clean.

12. **Editable vs View-Only Modes**
    - **Description:** In `edit` mode: fields are editable inputs. In `view` mode: same layout, but text is read-only.
    - **Acceptance:**
      - Inputs are enabled in `edit` mode; disabled or replaced by static text in `view` mode.
      - No accidental edits possible in `view` mode.

13. **Username Displays and Saves With “@” Prefix in UI**
    - **Description:** Username is visually shown with an `@` prefix but stored/saved without forcing that prefix into the underlying value (unless your system expects that).
    - **Acceptance:** UI shows `@username`; underlying value is `username` (per your system’s convention).

---

### 5. Social Links & “+” Flow

14. **Social Links Render as Compact Pills/Badges**
    - **Description:** Existing social links appear as small, modern chips/pills with an icon + text.
    - **Acceptance:** Each social link:
      - Displays an icon (generic external-link is fine).
      - Shows a label (e.g., “Instagram”) or truncated URL.

15. **Clicking Social Link Opens in New Tab**
    - **Description:** Clicking a social link opens the URL in a new tab.
    - **Acceptance:** Proper `target="_blank"` + security attributes, opening the correct URL.

16. **Add Social Link Flow With “+”**
    - **Description:** Clicking the `+` button shows an inline form to add a new social link (label + URL).
    - **Acceptance:**
      - The new input area appears near existing links.
      - User can cancel out of it.

17. **Enter Key Saves New Social Link**
    - **Description:** When focused in the new social link fields, pressing Enter adds the link.
    - **Acceptance:**
      - On Enter with a valid URL, the new link appears as another chip.
      - Fields clear and “add” mode exits.

18. **Remove Social Link in Edit Mode Only**
    - **Description:** In `edit` mode, each social chip has a small remove affordance (X icon); no removal in `view` mode.
    - **Acceptance:** 
      - In `edit` mode: clicking remove deletes the link.
      - In `view` mode: no remove icon or it is non-interactive.

---

### 6. Modes & Reusability

19. **Mode Prop Controls Behavior (Admin vs CRM)**
    - **Description:** The component accepts a mode (or equivalent) that switches between admin-edit behavior and CRM-read-only behavior.
    - **Acceptance:** Same component can be dropped into admin panel as editable and CRM as view-only with a single prop/config change.

20. **No Admin-Only Behavior Leaks Into CRM Mode**
    - **Description:** In `view`/CRM mode, no editing affordances show (no + for socials, no avatar upload, no input fields).
    - **Acceptance:** UI clearly communicates read-only; no edit controls appear.

---

### 7. Data Flow & State

21. **All Edits Flow Through a Single Contact Object**
    - **Description:** The sidebar maintains a single contact object that reflects all edits and can be sent back to the caller/app.
    - **Acceptance:** After editing (name, avatar, socials), the resulting contact object contains all updated fields in a consistent shape.

22. **Supports Parent-Controlled Save**
    - **Description:** Saving changes is exposed via a callback that the parent can use to persist to the backend.
    - **Acceptance:** No hard-coded persistence; the component hands off clean data for the parent to handle.

---

### 8. Design Guardrails & Accessibility

23. **Uses Platform’s shadcn Primitives**
    - **Description:** Inputs, buttons, labels, chips, scroll area, etc., use the shared shadcn/ui primitives and tokens.
    - **Acceptance:** Visual parity with the rest of the admin panel: same typography, spacing, radii, focus styles.

24. **Keyboard Accessible**
    - **Description:** All important interactions are keyboard accessible: tabbing into fields, using Enter to confirm, Space to toggle panel, Esc to close.
    - **Acceptance:** No mouse-only requirements; focus states and tab order are sensible.

25. **Reasonable Empty States**
    - **Description:** Handles no avatar, missing names, and no social links gracefully (fallback initials, simple empty message).
    - **Acceptance:** No broken layout or confusing “null” text when data is sparse.

---

If you’d like, Mr. White, I can condense this into a single JSON/YAML block formatted exactly for whatever eval runner you’re using (e.g., “name / description / acceptance_criteria” schema) without adding any implementation hints.
