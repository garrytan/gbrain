'use client'

import * as React from 'react'
import { Brain, Loader2 } from 'lucide-react'

import { api } from '@/lib/api'

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = React.useState<boolean | null>(null)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    setMounted(true)
    api.session()
      .then((session) => {
        if (!alive) return
        if (session.authenticated) {
          window.requestAnimationFrame(() => {
            if (alive) setAuthenticated(true)
          })
          return
        }
        window.location.href = '/admin/login'
      })
      .catch(() => {
        if (alive) window.location.href = '/admin/login'
      })

    return () => {
      alive = false
    }
  }, [])

  if (mounted && authenticated) return <>{children}</>

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Brain className="size-4" />
        </div>
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm">Opening Cortex admin...</span>
      </div>
    </main>
  )
}
