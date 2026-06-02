---
title: "Auto-close modal on update"
type: guide
created: 2025-11-22
updated: 2025-11-22
source: chatgpt-export
conversation_id: 6922468d-ce18-8326-8382-9643f4b6dcd0
message_count: 4
tags: [chatgpt, import, code]
---
# Auto-close modal on update

> Conversation ID: 6922468d-ce18-8326-8382-9643f4b6dcd0
> Created: 2025-11-22T23:26:15Z
> Updated: 2025-11-22T23:27:03Z
> Messages: 4

---

## User

When updating the profile, we needed to auto-close the modal.

---

## Assistant

Got it. The usual pattern is: after a successful profile update, flip the modal’s open state to `false` (or call the modal’s `close()`), *from the same success path that updates the profile data*. Don’t try to infer it indirectly from props re-rendering—make it explicit.

Here are a few solid ways to do it, depending on your setup:

### React (local state modal)
```tsx
function EditProfileModal({ open, onClose }) {
  const [saving, setSaving] = useState(false);

  async function handleSave(formValues) {
    setSaving(true);
    try {
      await api.updateProfile(formValues);
      toast.success("Profile updated");
      onClose();              // ✅ auto-close on success
    } catch (e) {
      toast.error("Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <ProfileForm onSubmit={handleSave} saving={saving} />
    </Modal>
  );
}
```

### React Query / TanStack Query
```tsx
const updateProfile = useMutation({
  mutationFn: api.updateProfile,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["profile"] });
    toast.success("Profile updated");
    setModalOpen(false);  // ✅ close here
  },
});

function handleSave(values) {
  updateProfile.mutate(values);
}
```

### If modal open is driven by route (e.g., `/profile/edit`)
On success, navigate away:
```tsx
const navigate = useNavigate();

const onSave = async (values) => {
  await api.updateProfile(values);
  navigate("/profile");   // ✅ leaving route closes modal
};
```

### Common pitfalls to avoid
- **Closing before the update finishes.** Only close in `onSuccess` / after `await`.
- **Tying close to “profile changed” effects.** That can close on initial load or other edits. Prefer a direct success callback.
- **Not handling errors.** You want the modal to stay open if saving fails.

If you want, paste your current save handler + modal state wiring and I’ll point to the exact line to add the close.

---

## User

Just add it to the list. And then there's also some weird bug happening where when I input my height as 6'4", sometimes that's 6'3", and then sometimes 6'4".

---

## Assistant

Sure, Mr. White — adding it to the list, and capturing the height bug clearly.

### List (updated)
1. **Profile update should auto-close modal on success.**  
   - Close explicitly in the save success path (`onSuccess` / after `await`).

2. **Height input intermittently flips between 6'4" and 6'3".**  
   - Likely parsing/rounding/state sync issue.

---

### Height bug — likely causes + fixes

Here are the most common reasons this happens, in order of likelihood:

**A) Off-by-one from float conversion**
- If you convert `6'4"` → inches → cm → inches again, you can lose a fraction and floor it.
- Example: `76 in * 2.54 = 193.04 cm`.  
  If later you do `Math.floor(cm / 2.54)` you get `75 in` → `6'3"`.

**Fix**
- Store canonical value as **integer inches** (or integer cm), not floats.
- When converting back, **round to nearest** before splitting feet/inches.

```ts
// canonical storage: inches (int)
const totalInches = feet * 12 + inches;

// display
const feetOut = Math.floor(totalInches / 12);
const inchesOut = totalInches % 12;

// if converting from cm:
const totalInches = Math.round(cm / 2.54);
```

---

**B) Using `parseInt` on a string like `6'4"`**
- `parseInt("6'4\"")` returns `6` and silently drops the rest.
- Or a regex that sometimes fails (depending on quotes) and defaults inches to 3.

**Fix**
- Normalize quotes and parse with a strict regex; never fallback silently.

```ts
function parseHeight(input: string) {
  const normalized = input.replace(/[″”“]/g, '"').replace(/[’‘]/g, "'");
  const m = normalized.match(/^\s*(\d+)\s*'\s*(\d+)\s*"?\s*$/);
  if (!m) throw new Error("invalid height");
  const feet = Number(m[1]);
  const inches = Number(m[2]);
  return feet * 12 + inches; // int inches
}
```

---

**C) Controlled/uncontrolled input mismatch**
- If the form field is controlled by state that updates from the server, a late re-render can overwrite your typed value with stale data (sometimes 6'3", sometimes 6'4").

**Fix**
- Only initialize form state from profile once, not on every profile change.  
- Or gate the hydration:

```ts
const [form, setForm] = useState(() => profileToForm(profile));
const hydratedRef = useRef(false);

useEffect(() => {
  if (!hydratedRef.current && profile) {
    setForm(profileToForm(profile));
    hydratedRef.current = true;
  }
}, [profile]);
```

---

**D) Inches clamping/normalization bug**
- A “sanitize” step might be doing:
  - `if inches >= 12 { feet += 1; inches = 0 }`
  - but with a wrong comparison or rounding, `4` becomes `3`.

**Fix**
- Ensure sanitization is integer-safe and only runs on blur/submit, not every keystroke.

---

### Quick debug checklist
- Log these at save + at render:
  1. raw input string
  2. parsed total inches
  3. stored value (what you send to API)
  4. value coming back from API
  5. display conversion result
- The first point where it drops from 76 → 75 is your culprit.

If you want to paste the height parse/convert code path (input handler + submit + display), I’ll mark the exact failure point and the minimal patch.
