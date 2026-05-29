'use client'

import * as React from 'react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface HealthIndicatorProps {
  className?: string
}

type HealthPayload = {
  expiring_soon?: number
  error_rate?: string
}

export function HealthIndicator({ className }: HealthIndicatorProps) {
  const [health, setHealth] = React.useState<HealthPayload>({ expiring_soon: 0, error_rate: '0%' })

  React.useEffect(() => {
    api.health().then(setHealth).catch(() => undefined)
  }, [])

  const isHealthy = Number(health.expiring_soon || 0) === 0 && String(health.error_rate || '0%') === '0%'
  const label = isHealthy ? 'All systems operational' : 'Attention needed'

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn('flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-accent', className)}
            aria-label={`System health: ${label}`}
          >
            <span className={cn('size-2 rounded-full', isHealthy ? 'bg-success' : 'bg-warning')} />
            <span className="hidden text-xs text-muted-foreground sm:inline">Health</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="w-64">
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <span className={cn('size-2 rounded-full', isHealthy ? 'bg-success' : 'bg-warning')} />
              {label}
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Expiring tokens</span>
              <span>{health.expiring_soon || 0}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Error rate</span>
              <span>{health.error_rate || '0%'}</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
