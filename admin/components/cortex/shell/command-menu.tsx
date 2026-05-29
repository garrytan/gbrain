'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity,
  Bot,
  Brain,
  Database,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Plus,
  PlugZap,
  Rocket,
  Search,
  Settings,
  Sparkles,
  UserPlus,
  Users,
  Workflow,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'

const navigationCommands = [
  { name: 'Overview', href: '/overview', icon: LayoutDashboard },
  { name: 'Onboarding', href: '/onboarding', icon: Rocket },
  { name: 'Brains', href: '/brains', icon: Brain },
  { name: 'Sources', href: '/sources', icon: Database },
  { name: 'Team', href: '/team', icon: Users },
  { name: 'Invites', href: '/invites', icon: UserPlus },
  { name: 'Composio', href: '/integrations', icon: PlugZap },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Skills', href: '/skills', icon: Sparkles },
  { name: 'Runtime', href: '/runtime', icon: KeyRound },
  { name: 'Jobs', href: '/jobs', icon: Workflow },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Quality', href: '/quality', icon: Gauge },
  { name: 'Settings', href: '/settings', icon: Settings },
]

const actionCommands = [
  { name: 'Create Brain', href: '/brains', icon: Plus },
  { name: 'Add Source', href: '/sources', icon: Plus },
  { name: 'Invite Member', href: '/team', icon: UserPlus },
  { name: 'Register Agent', href: '/agents', icon: Bot },
  { name: 'Open Runtime Manifest', href: '/runtime', icon: KeyRound },
  { name: 'Run Quality Review', href: '/quality', icon: Gauge },
]

export function CommandMenu() {
  const [open, setOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    setMounted(true)
    const down = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const run = React.useCallback((href: string) => {
    setOpen(false)
    router.push(href)
  }, [router])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-2 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Search...</span>
      </Button>
      {mounted ? (
        <CommandDialog open={open} onOpenChange={setOpen}>
          <CommandInput placeholder="Type a command or search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Navigation">
              {navigationCommands.map((item) => (
                <CommandItem key={item.href} value={item.name} onSelect={() => run(item.href)}>
                  <item.icon className="mr-2 size-4" />
                  {item.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              {actionCommands.map((item) => (
                <CommandItem key={item.href} value={item.name} onSelect={() => run(item.href)}>
                  <item.icon className="mr-2 size-4" />
                  {item.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Help">
              <CommandItem onSelect={() => window.open('https://docs.cortex.dev', '_blank')}>
                <FileText className="mr-2 size-4" />
                Documentation
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      ) : null}
    </>
  )
}
