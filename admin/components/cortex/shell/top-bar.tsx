'use client'

import { Slash } from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { OrgSwitcher } from './org-switcher'
import { BrainSwitcher } from './brain-switcher'
import { EnvBadge } from './env-badge'
import { HealthIndicator } from './health-indicator'
import { CommandMenu } from './command-menu'

export function TopBar() {
  return (
    <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      {/* Left section: Sidebar trigger + breadcrumb-style switchers */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="h-4" />
        
        {/* Organization / Brain switcher pattern (like Vercel's project switcher) */}
        <div className="flex min-w-0 items-center gap-1">
          <OrgSwitcher className="min-w-0" />
          <Slash className="hidden size-4 text-muted-foreground/50 -rotate-12 sm:block" />
          <BrainSwitcher className="hidden min-w-0 sm:inline-flex" />
        </div>
        
        <Separator orientation="vertical" className="hidden h-4 md:block" />
        <div className="hidden md:block">
          <EnvBadge />
        </div>
      </div>

      {/* Right section: Command menu + Health */}
      <div className="flex shrink-0 items-center gap-2">
        <CommandMenu />
        <Separator orientation="vertical" className="h-4" />
        <HealthIndicator />
      </div>
    </header>
  )
}
