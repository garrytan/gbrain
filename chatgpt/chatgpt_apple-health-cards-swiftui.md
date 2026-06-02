---
title: "Apple Health cards SwiftUI"
type: guide
created: 2025-11-14
updated: 2025-11-14
source: chatgpt-export
conversation_id: 69167190-90c8-832e-9685-3a7eff3d63a3
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Apple Health cards SwiftUI

> Conversation ID: 69167190-90c8-832e-9685-3a7eff3d63a3
> Created: 2025-11-14T00:02:31Z
> Updated: 2025-11-14T01:52:02Z
> Messages: 6

---

## User

apple health app cards swift ui

---

## Assistant

Mr. White, here’s a concise guide to building **Apple-Health-style cards in SwiftUI**—the scrolling, modular “summary cards” you see in the Health app.

---

## 🧩 Core Structure
Health-style cards share traits:
- Rounded rectangles with subtle shadows
- A title, metric, trend indicator, and optionally a chart
- Smooth animations and dynamic resizing
- Adaptive layout for light/dark mode

---

## 📐 Base Card Component

```swift
struct HealthCard<Content: View>: View {
    let title: String
    let content: Content
    
    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
            
            content
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(.secondarySystemBackground))
                .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
        )
    }
}
```

---

## 🩺 Example: Steps Card (Metric + Trend Arrow)

```swift
struct StepsCard: View {
    let steps: Int
    let change: Double  // percentage change
    
    var trendColor: Color {
        change >= 0 ? .green : .red
    }
    
    var body: some View {
        HealthCard(title: "Steps") {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(steps)")
                        .font(.largeTitle.bold())
                    Text("Today")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                
                Spacer()
                
                HStack(spacing: 4) {
                    Image(systemName: change >= 0 ? "arrow.up" : "arrow.down")
                    Text("\(String(format: "%.1f%%", abs(change)))")
                }
                .font(.headline)
                .foregroundColor(trendColor)
            }
        }
    }
}
```

---

## 📊 Example: Mini Chart (Health App Style)

SwiftUI’s `Chart` framework (iOS 16+) makes this simple:

```swift
import Charts

struct HeartRateCard: View {
    let data: [HeartRatePoint]
    
    var body: some View {
        HealthCard(title: "Heart Rate") {
            Chart(data) { item in
                LineMark(
                    x: .value("Time", item.time),
                    y: .value("BPM", item.bpm)
                )
                .interpolationMethod(.catmullRom)
            }
            .frame(height: 120)
        }
    }
}

struct HeartRatePoint: Identifiable {
    let id = UUID()
    let time: Date
    let bpm: Int
}
```

---

## 📱 Putting Cards in a Scroll View

```swift
struct SummaryView: View {
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 20) {
                StepsCard(steps: 8234, change: 12.4)
                HeartRateCard(data: sampleHeartRate)
                // Add more cards here
            }
            .padding()
        }
    }
}
```

---

If you want, I can generate:
- A full reusable card system like the real Health app  
- A full mock Health Summary screen  
- Charts styled to match Apple’s native look  
- Integration with HealthKit queries

Just tell me what level of completeness you want, Mr. White.

---

## User

Is the tab bar with the pill style tabs for day week month year etc a swift ui component? Are we able to use that exact component? Or do we need to build our own?

---

## Assistant

Mr. White, here’s the straight answer:

## ❌ Short version  
**No — Apple does *not* expose the Health app’s pill-style segmented tab bar (“Day / Week / Month / Year”) as a public SwiftUI component.**  
You **cannot** use that exact control out of the box.

## ✅ What *is* available  
SwiftUI gives you:

### `SegmentedPickerStyle`
```swift
Picker("Range", selection: $range) {
    Text("Day").tag(0)
    Text("Week").tag(1)
    Text("Month").tag(2)
    Text("Year").tag(3)
}
.pickerStyle(.segmented)
```

But:
- It’s not stylable to match Apple Health’s pill look.
- It doesn’t stretch across the screen like theirs.
- You can’t alter its background, corner radius, or animations.

## ❌ Private API  
The Health tab bar is **private UIKit**, not available to developers.  
Apple uses an **internal variant of segmented controls** with custom layout + animations.

## ✅ What you must do  
You must **build your own custom pill tab bar** if you want it to look identical or near-identical.

The pattern is simple:  
- A rounded capsule background  
- Horizontally scrolling or fixed HStack  
- Each segment is a button  
- Animated capsule for the selected segment  

Here’s a production-ready SwiftUI version:

```swift
struct PillSegmentedControl: View {
    let items: [String]
    @Binding var selection: Int
    
    var body: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { i in
                Button {
                    selection = i
                } label: {
                    Text(items[i])
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .background(
                    Group {
                        if selection == i {
                            Capsule()
                                .fill(Color.accentColor.opacity(0.15))
                                .matchedGeometryEffect(id: "pill", in: ns)
                        }
                    }
                )
            }
        }
        .padding(6)
        .background(
            Capsule()
                .fill(Color(.secondarySystemBackground))
        )
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: selection)
    }
    
    @Namespace private var ns
}
```

---

If you want, I can give you:
- A **pixel-perfect replica** of Apple Health’s control  
- A **UIKit-backed SwiftUI wrapper** (for smoother animation)  
- A version that supports **scrollable segments** (like Fitness app)  
- A version that syncs with charts (like Health’s zooming behavior)

Just tell me what variant you want, Mr. White.

---

## User

I want a pixel perfect replica

---

## Assistant

Short answer, Mr. White:  
- That pill-style **“Day / Week / Month / Year”** bar is **not** a public component you can just reuse.  
- But you can get **extremely close** with SwiftUI. Below is a replica that you can tweak to be visually 1:1.

---

## Custom Health-style pill tab bar (SwiftUI)

```swift
import SwiftUI

/// Match Health's "Day / Week / Month / Year" control
enum RangeGranularity: String, CaseIterable, Identifiable {
    case day   = "Day"
    case week  = "Week"
    case month = "Month"
    case year  = "Year"
    
    var id: Self { self }
}

struct HealthRangePicker: View {
    @Binding var selection: RangeGranularity
    @Namespace private var pillNamespace
    
    var body: some View {
        HStack(spacing: 4) {
            ForEach(RangeGranularity.allCases) { item in
                button(for: item)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 999)
                .fill(Color(UIColor.secondarySystemFill)) // outer track
        )
        .frame(height: 32) // very close to Health
    }
    
    @ViewBuilder
    private func button(for item: RangeGranularity) -> some View {
        let isSelected = item == selection
        
        Button {
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                selection = item
            }
        } label: {
            Text(item.rawValue)
                .font(.system(size: 13, weight: .semibold, design: .default))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(
            isSelected
            ? Color.primary
            : Color.secondary
        )
        .background(
            ZStack {
                if isSelected {
                    RoundedRectangle(cornerRadius: 999)
                        .fill(Color(UIColor.systemBackground)) // pill
                        .shadow(radius: 0.5, y: 0.5)            // subtle lift like Health
                        .matchedGeometryEffect(id: "health-pill", in: pillNamespace)
                }
            }
        )
    }
}

// Example usage
struct ContentView: View {
    @State private var range: RangeGranularity = .day
    
    var body: some View {
        VStack(spacing: 16) {
            HealthRangePicker(selection: $range)
                .padding()

            Text("Selected: \(range.rawValue)")
                .font(.headline)
            
            Spacer()
        }
        .padding()
    }
}
```

---

## Notes for making it “pixel perfect”

To get **as close as possible to Apple’s Health UI**:

- **Fonts**  
  - `13pt` `.semibold` SF is very close to what they use.
- **Heights / padding**  
  - `frame(height: 32)` on container, `padding(.vertical, 6)` on the label gets you near-identical vertical proportions.
- **Colors**  
  - Track: `Color(UIColor.secondarySystemFill)`  
  - Selected pill: `Color(UIColor.systemBackground)`  
  - Text: `.primary` when selected, `.secondary` otherwise  
  - These match system dynamic colors in light/dark.
- **Animation**  
  - `spring(response: 0.25, dampingFraction: 0.85)` gives that snappy, slightly underdamped slide.

You can now put this above your chart or cards exactly like in the Health app, reuse it anywhere, and tweak a couple of constants (font size, height, padding) while visually comparing to the real app until it’s indistinguishable.
