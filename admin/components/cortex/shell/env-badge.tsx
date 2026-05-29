'use client'

export function EnvBadge() {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-success" />
      <span>production</span>
    </div>
  )
}
