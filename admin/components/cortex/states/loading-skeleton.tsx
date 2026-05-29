import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

interface LoadingSkeletonProps {
  variant?: 'table' | 'cards' | 'detail'
  rows?: number
  className?: string
}

/**
 * LoadingSkeleton - Loading placeholder animations
 * 
 * Purpose: Show loading state while data fetches
 * Size: Matches final content dimensions to prevent layout shift
 * Flow: Shimmer animation draws attention without distraction
 */
export function LoadingSkeleton({
  variant = 'table',
  rows = 5,
  className,
}: LoadingSkeletonProps) {
  if (variant === 'cards') {
    return (
      <div className={cn('grid gap-4 md:grid-cols-2 lg:grid-cols-4', className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border p-4 space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    )
  }

  if (variant === 'detail') {
    return (
      <div className={cn('space-y-6', className)}>
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-6 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Table variant (default)
  return (
    <div className={cn('space-y-3', className)}>
      {/* Table header */}
      <div className="flex gap-4 px-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {/* Table rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3 border-b border-border">
          {Array.from({ length: 5 }).map((_, j) => (
            <Skeleton key={j} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  )
}
