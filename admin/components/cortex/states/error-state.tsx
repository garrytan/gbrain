import { AlertCircle, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface ErrorStateProps {
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
}

/**
 * ErrorState - Error display with retry option
 * 
 * Purpose: Inform users of errors and offer recovery
 * Size: Centered, similar to EmptyState for visual consistency
 * Flow: Icon -> Message -> Retry button
 */
export function ErrorState({
  title = 'Something went wrong',
  message = 'An error occurred while loading data. Please try again.',
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-16 px-4 text-center',
        className
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-error/10 mb-4">
        <AlertCircle className="size-6 text-error" />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-4">
          <RefreshCw className="mr-2 size-4" />
          Try again
        </Button>
      )}
    </div>
  )
}
