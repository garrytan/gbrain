'use client'

import * as React from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface StatCardProps {
  title: string
  value: string | number
  description?: string
  trend?: number // percentage change
  trendLabel?: string
  icon?: React.ReactNode
  variant?: 'default' | 'warning' | 'error' | 'success'
  className?: string
}

/**
 * StatCard - Displays a key metric with optional trend indicator
 * 
 * Purpose: Provide at-a-glance metrics for dashboard overview
 * Size: Fixed height (auto width) to maintain grid alignment
 * Flow: Icon + title top, large value center, trend/description bottom
 */
export function StatCard({
  title,
  value,
  description,
  trend,
  trendLabel,
  icon,
  variant = 'default',
  className,
}: StatCardProps) {
  const variantStyles = {
    default: '',
    warning: 'border-warning/20 bg-warning/5',
    error: 'border-error/20 bg-error/5',
    success: 'border-success/20 bg-success/5',
  }

  return (
    <Card className={cn(variantStyles[variant], className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        {icon && (
          <div className="text-muted-foreground">{icon}</div>
        )}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {(trend !== undefined || description) && (
          <div className="flex items-center gap-1 mt-1">
            {trend !== undefined && <TrendIndicator value={trend} />}
            {(trendLabel || description) && (
              <p className="text-xs text-muted-foreground">
                {trendLabel || description}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function TrendIndicator({ value }: { value: number }) {
  if (value === 0) {
    return (
      <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="size-3" />
        0%
      </span>
    )
  }

  const isPositive = value > 0
  const Icon = isPositive ? TrendingUp : TrendingDown
  
  return (
    <span
      className={cn(
        'flex items-center gap-0.5 text-xs font-medium',
        isPositive ? 'text-success' : 'text-error'
      )}
    >
      <Icon className="size-3" />
      {isPositive ? '+' : ''}{value.toFixed(1)}%
    </span>
  )
}
