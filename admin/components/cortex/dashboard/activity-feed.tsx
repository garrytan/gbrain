'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import {
  Database,
  UserPlus,
  Bot,
  Sparkles,
  AlertCircle,
  Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ActivityItem } from '@/lib/types'

interface ActivityFeedProps {
  items: ActivityItem[]
  className?: string
}

const activityIcons = {
  source_synced: Database,
  member_joined: UserPlus,
  agent_created: Bot,
  skill_run: Sparkles,
  job_failed: AlertCircle,
  health_changed: Activity,
}

const activityColors = {
  source_synced: 'text-success bg-success/10',
  member_joined: 'text-info bg-info/10',
  agent_created: 'text-chart-1 bg-chart-1/10',
  skill_run: 'text-chart-2 bg-chart-2/10',
  job_failed: 'text-error bg-error/10',
  health_changed: 'text-warning bg-warning/10',
}

/**
 * ActivityFeed - Recent activity timeline
 * 
 * Purpose: Keep users informed of recent system events
 * Size: Fixed height with internal scroll for overflow
 * Flow: Chronological list with icon indicators
 */
export function ActivityFeed({ items, className }: ActivityFeedProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[320px]">
          <div className="space-y-1 px-6 pb-4">
            {items.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = activityIcons[item.type]
  const colorClass = activityColors[item.type]

  return (
    <div className="flex items-start gap-3 py-2 group">
      <div
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-full',
          colorClass
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{item.title}</p>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {item.description}
          </p>
        )}
      </div>
      <time className="text-xs text-muted-foreground shrink-0">
        {formatDistanceToNow(item.timestamp, { addSuffix: true })}
      </time>
    </div>
  )
}
