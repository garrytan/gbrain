'use client'

import * as React from 'react'
import { Check, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'

interface ChecklistItem {
  id: string
  label: string
  completed: boolean
  href?: string
}

interface OnboardingChecklistProps {
  items: ChecklistItem[]
  className?: string
}

/**
 * OnboardingChecklist - Setup progress tracker
 * 
 * Purpose: Guide new users through initial configuration
 * Size: Compact list that expands as needed
 * Flow: Progress bar + clickable checklist items
 */
export function OnboardingChecklist({ items, className }: OnboardingChecklistProps) {
  const completedCount = items.filter((i) => i.completed).length
  const totalCount = items.length
  const progress = (completedCount / totalCount) * 100

  if (completedCount === totalCount) {
    return null // Hide when complete
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">Setup Progress</CardTitle>
          <span className="text-xs text-muted-foreground">
            {completedCount} of {totalCount}
          </span>
        </div>
        <Progress value={progress} className="h-1.5 mt-2" />
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => (
          <ChecklistRow key={item.id} item={item} />
        ))}
      </CardContent>
    </Card>
  )
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 py-2 px-2 -mx-2 rounded-md transition-colors',
        !item.completed && 'hover:bg-muted/50 cursor-pointer'
      )}
    >
      <div
        className={cn(
          'flex size-5 items-center justify-center rounded-full border',
          item.completed
            ? 'bg-success border-success text-success-foreground'
            : 'border-muted-foreground/30'
        )}
      >
        {item.completed ? (
          <Check className="size-3" />
        ) : (
          <Circle className="size-3 text-muted-foreground/50" />
        )}
      </div>
      <span
        className={cn(
          'text-sm flex-1',
          item.completed && 'text-muted-foreground line-through'
        )}
      >
        {item.label}
      </span>
      {!item.completed && item.href && (
        <Button variant="ghost" size="sm" className="h-7 text-xs">
          Start
        </Button>
      )}
    </div>
  )
}
