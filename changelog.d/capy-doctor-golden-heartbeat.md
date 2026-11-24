### For contributors
- The `gbrain doctor --json` golden tests no longer fail on a slow CI runner. A doctor run past 10 s prints a `still reading doctor checks (N s so far)` progress line, and the test compares two captures byte for byte. The golden normalizer (test/helpers/doctor-json-golden.ts) now drops those lines and keeps every other stderr line.
