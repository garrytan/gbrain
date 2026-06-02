---
title: "Improve UI design"
type: guide
created: 2025-11-09
updated: 2025-11-09
source: chatgpt-export
conversation_id: 691014ce-cfc0-8327-a843-2231ffbf3814
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Improve UI design

> Conversation ID: 691014ce-cfc0-8327-a843-2231ffbf3814
> Created: 2025-11-09T04:13:29Z
> Updated: 2025-11-09T04:18:59Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_00000000e6b8720c8f6c388541192b3c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 118209, 'width': 708}
{'asset_pointer': 'sediment://file_000000000668720cb8c5f13c9421f3e3', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 107016, 'width': 708}
Attached is our app and Apple health app. How do we get our design to look as good as theirs?

---

## Assistant

Big picture, Mr. White: you’re very close. The Apple Health screen just does a few fundamentals better: hierarchy, spacing, and typography. If you fix those, your UI will feel just as “native”.

I’ll go card-by-card and keep it concrete.

---

### 1. Numbers & typography (your biggest win)

**What Health does**

- One clear hero number per card:  
  `160` (large) + `lbs` (small, same baseline)  
  `10.2` (large) + `%` (small)
- No line breaks inside the number, no extra zero rows.

**What your app is doing**

- Weight: `16` on one line and `0.0` on the next → reads as “16 lbs, 0.0”.
- Body fat: `10.` on one line and `2` on the next → reads as “10.% 2”.
- Units (“lbs”, “%”) are drifting away from the value.

**What to change**

- Treat the numeric value as **one string** and force it to stay on one line.
  - Example: `"160"` (UIFontTextStyleTitle1 / large bold)  
    `"lbs"` (subheadline / regular) as a **separate label**, trailing, same baseline.
- For body fat: `"10.2"` + `"%"`
- Drop the extra decimal row when it’s `.0`. Show `160` not `160.0` unless decimals matter.
- Limit yourself to **two text sizes in each card**:
  - Label (“Weight”, “Body Fat Percentage”): caption/footnote, medium.
  - Value: large title / bold.
  - Units + “steps”, “lbs”, “%”: smaller, regular.

---

### 2. Visual hierarchy & layout

**Health cards**

- Top row: metric name + icon (left), time (right).  
- Big numeric value centered vertically in the left 60–65% of the card.  
- Graph tucked neatly on the right, same vertical center as the number.
- Plenty of breathing room around all edges (looks like ~16–20pt padding).

**Your cards**

- Structure is similar but spacing is tighter and the value/graph feel crowded.
- Numbers sit lower; the line chart feels like a separate block.

**Actionable tweaks**

- Use a **4-pt or 8-pt spacing system** and stick to it everywhere:
  - 16–20pt padding inside each card.
  - 8–12pt from label (“Weight”) down to the value.
  - 8–12pt between value and graph.
- Vertically center the value and graph within the card.
- Keep the graph in a fixed-width column (e.g., right 30–35% of the card) so all cards align visually when you scroll.

---

### 3. Text & icon treatment

**Health**

- Icon and label share the same color, small and subtle.
- Time stamp is small, low contrast (secondary text color).

**Your app**

- Very close, but everything feels a bit “louder”.

**Improvements**

- Use system colors:
  - Label + icon: `systemOrange`, `systemPurple`, etc. at ~80% opacity.
  - Time: `secondaryLabel` color, small font.
- Reduce icon size slightly and keep a fixed gap (e.g., 4–6pt) between icon and label.
- Ensure icon+label baseline aligns cleanly with the time on the right.

---

### 4. Top nav & header

**Health**

- Bold “Summary” title, simple “Pinned” subheading.  
- Gradient is nice but the content cards are what carry the design.

**Your app**

- Avatar + “Synced just now • Works offline” + segmented control + floating home bar → quite a lot of UI before we see the metrics.

**Recommendations**

- Decide what’s primary:
  - If “Metrics” is the main thing, use a simple title like `Metrics` at the top.
  - Move “Synced just now • Works offline” to smaller, secondary text under the title or inside a settings/status area.
- Consider making the `Photo / Metrics` toggle look more like a native segmented control (smaller height, more padding around labels).

---

### 5. Color & graphs

**Health**

- Dark grey cards on black background.  
- One accent color per metric.  
- Graphs are thin, subtle, with soft corner clipping.

**Your app**

- Colors are close but graphs feel slightly heavier / more neon.

**Adjustments**

- Use a thinner stroke for your line charts.
- Use the same accent color as the label/icon, maybe at ~70–80% opacity.
- Ensure graphs respect the same corner radius as the card (no sharp edges touching the border).

---

### 6. Consistency rules (design system level)

If you write these down and enforce them, the whole app will look “Apple-level”:

1. **Typography scale**
   - Title (screen): SF Pro / Large Title.
   - Card label: Footnote/Caption, Medium.
   - Value: Title 1 or 2, Bold.
   - Units & metadata: Subheadline/Footnote, Regular.

2. **Spacing**
   - Outer padding inside cards: 16–20pt.
   - Vertical rhythm: multiples of 4pt.
   - Card-to-card spacing: 12–16pt.

3. **Numbers**
   - Never wrap digits across lines.
   - One primary value per card.
   - Units are always smaller, same baseline, low contrast.

4. **Color**
   - Background: pure black / near-black.
   - Card: one consistent dark grey.
   - One accent color per metric; everything else greyscale.

---

If you’d like, Mr. White, I can take one of your cards (e.g., the Weight card) and write out a pseudo-layout (Auto Layout/VStack constraints) that matches the Health design exactly so your devs can just implement it.

---

## User

Yes

---

## Assistant

Got you, Mr. White. Let’s blueprint a **Weight** card that matches Health’s look. I’ll give you:

- A layout spec (what sits where, sizes, spacing).  
- SwiftUI version.  
- UIKit / Auto Layout version.

You can mirror this for all metrics.

---

## 1. Layout spec (Weight card)

**Card container**

- Background: `Color(.secondarySystemBackground)` (dark grey on black).
- Corner radius: `16`
- Internal padding: `16` on all sides.
- Height: ~120–140pt (or content-hugging if you prefer).

**Inside the card**

Column layout:

1. **Top row**
   - Left: 🔸 icon + “Weight” label (HStack)
   - Right: time label (e.g., “8:48 AM”)

2. **Middle row**
   - Big weight value: `160`
   - Small unit aligned to baseline: `lbs`

3. **Bottom row**
   - Mini line chart aligned to the right side, fixed height (e.g., 40pt).

**Typography**

- Label “Weight”: SF Pro Text, `caption1`, weight `.medium`, color = accent (e.g., systemPurple).
- Time: SF Pro Text, `caption1`, `.regular`, color = `.secondaryLabel`.
- Value “160”: SF Pro Display/Text, `title2` or `largeTitle` (depending on card size), `.bold`, color = `.label`.
- Unit “lbs”: SF Pro Text, `subheadline`, `.regular`, color = `.secondaryLabel`.

**Spacing**

- Top row ↔ middle row: `12`
- Middle row ↔ bottom row: `12`
- Icon ↔ “Weight”: `4`
- Between value and unit: `4`

---

## 2. SwiftUI implementation

```swift
struct MetricCardWeight: View {
    let value: Double      // 160
    let unit: String       // "lbs"
    let timeString: String // "8:48 AM"
    
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        }
        .overlay(
            VStack(alignment: .leading, spacing: 12) {
                
                // TOP ROW: label + time
                HStack {
                    HStack(spacing: 4) {
                        Image(systemName: "figure.walk") // or your weight icon
                            .font(.caption)
                        Text("Weight")
                            .font(.caption)
                            .fontWeight(.medium)
                    }
                    .foregroundColor(Color(.systemPurple))
                    
                    Spacer()
                    
                    Text(timeString)
                        .font(.caption)
                        .foregroundColor(Color(.secondaryLabel))
                }
                
                // MIDDLE ROW: value + unit
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(value.cleanNoTrailingZeros) // "160" or "160.2"
                        .font(.system(size: 34, weight: .bold, design: .default))
                        .foregroundColor(Color(.label))
                    
                    Text(unit) // "lbs"
                        .font(.subheadline)
                        .foregroundColor(Color(.secondaryLabel))
                }
                
                // BOTTOM ROW: graph
                HStack {
                    Spacer()
                    LineChartMiniView() // your miniature graph view
                        .frame(width: 120, height: 40)
                }
            }
            .padding(16)
        )
        .frame(maxWidth: .infinity, minHeight: 120)
    }
}

// Helper: formats 160.0 as "160"
extension Double {
    var cleanNoTrailingZeros: String {
        let formatter = NumberFormatter()
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
```

Key points:

- `HStack(alignment: .firstTextBaseline)` keeps `160` and `lbs` on the same line and aligned like Apple Health.
- `NumberFormatter` avoids `160.0` unless you need the decimal.
- `LineChartMiniView` should use a thin stroke and the same `systemPurple` color at ~70–80% opacity.

---

## 3. UIKit / Auto Layout version (Weight card)

```swift
final class WeightMetricCardView: UIView {
    
    private let iconView = UIImageView(image: UIImage(systemName: "figure.walk"))
    private let titleLabel = UILabel()
    private let timeLabel = UILabel()
    private let valueLabel = UILabel()
    private let unitLabel = UILabel()
    private let chartView = MiniLineChartView()
    
    override init(frame: CGRect) {
        super.init(frame: frame)
        setupView()
        setupLayout()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    private func setupView() {
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 16
        layer.masksToBounds = true
        
        iconView.tintColor = .systemPurple
        iconView.contentMode = .scaleAspectFit
        
        titleLabel.text = "Weight"
        titleLabel.font = UIFont.preferredFont(forTextStyle: .caption1).withWeight(.medium)
        titleLabel.textColor = .systemPurple
        
        timeLabel.font = UIFont.preferredFont(forTextStyle: .caption1)
        timeLabel.textColor = .secondaryLabel
        
        valueLabel.font = UIFont.systemFont(ofSize: 34, weight: .bold)
        valueLabel.textColor = .label
        
        unitLabel.font = UIFont.preferredFont(forTextStyle: .subheadline)
        unitLabel.textColor = .secondaryLabel
        
        chartView.translatesAutoresizingMaskIntoConstraints = false
        
        [iconView, titleLabel, timeLabel, valueLabel, unitLabel, chartView].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
    }
    
    private func setupLayout() {
        // TOP ROW
        NSLayoutConstraint.activate([
            iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            iconView.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            iconView.heightAnchor.constraint(equalToConstant: 14),
            iconView.widthAnchor.constraint(equalToConstant: 14),
            
            titleLabel.leadingAnchor.constraint(equalTo: iconView.trailingAnchor, constant: 4),
            titleLabel.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
            
            timeLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            timeLabel.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
        ])
        
        // VALUE + UNIT (baseline aligned)
        NSLayoutConstraint.activate([
            valueLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            valueLabel.topAnchor.constraint(equalTo: iconView.bottomAnchor, constant: 12),
            
            unitLabel.leadingAnchor.constraint(equalTo: valueLabel.trailingAnchor, constant: 4),
            unitLabel.firstBaselineAnchor.constraint(equalTo: valueLabel.firstBaselineAnchor)
        ])
        
        // CHART (bottom-right)
        NSLayoutConstraint.activate([
            chartView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            chartView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            chartView.widthAnchor.constraint(equalToConstant: 120),
            chartView.heightAnchor.constraint(equalToConstant: 40),
            
            // Card minimum height
            bottomAnchor.constraint(greaterThanOrEqualTo: valueLabel.bottomAnchor, constant: 16)
        ])
    }
    
    func configure(value: Double, unit: String, timeString: String) {
        valueLabel.text = value.cleanStringNoTrailingZeros
        unitLabel.text = unit
        timeLabel.text = timeString
    }
}

private extension UIFont {
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let metrics = UIFontMetrics(forTextStyle: .caption1)
        let descriptor = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
        return metrics.scaledFont(for: UIFont(descriptor: descriptor, size: 0))
    }
}

private extension Double {
    var cleanStringNoTrailingZeros: String {
        let f = NumberFormatter()
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = 1
        return f.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
```

You can now:

- Duplicate this view/SwiftUI component for **Steps**, **Body Fat %**, **Lean Mass**, etc.
- Only change: icon, label text, value/unit, accent color, and maybe chart data.

If you send me one of your current code snippets, I can refactor it directly into this structure so your devs can drop it in without guessing.
