'use client'

import * as React from 'react'
import { Brain as BrainIcon, Check, ChevronsUpDown, Plus } from 'lucide-react'

import { api } from '@/lib/api'
import type { BrainSummary } from '@/lib/saas-model'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface BrainSwitcherProps {
  className?: string
}

export function BrainSwitcher({ className }: BrainSwitcherProps) {
  const [open, setOpen] = React.useState(false)
  const [brains, setBrains] = React.useState<BrainSummary[]>([])
  const [selectedBrainId, setSelectedBrainId] = React.useState('')

  React.useEffect(() => {
    api.brains()
      .then((rows: BrainSummary[]) => {
        setBrains(rows)
        setSelectedBrainId((current) => current || rows[0]?.id || '')
      })
      .catch(() => undefined)
  }, [])

  const selectedBrain = brains.find((brain) => brain.id === selectedBrainId)
  const label = selectedBrain?.name || 'Company Brain'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Select brain"
          className={cn('h-8 gap-2 px-2 font-normal', className)}
        >
          <BrainIcon className="size-4 text-muted-foreground" />
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search brain..." className="h-9" />
          <CommandList>
            <CommandEmpty>No brain found.</CommandEmpty>
            <CommandGroup heading="Brains">
              {brains.map((brain) => (
                <CommandItem
                  key={brain.id}
                  value={brain.name}
                  onSelect={() => {
                    setSelectedBrainId(brain.id)
                    setOpen(false)
                  }}
                  className="gap-2"
                >
                  <BrainIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{brain.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{brain.region || brain.public_url || brain.id}</span>
                  </div>
                  <HealthDot status={brain.status} />
                  <Check className={cn('size-4 shrink-0', selectedBrainId === brain.id ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  window.location.href = '/admin/brains'
                }}
                className="gap-2"
              >
                <Plus className="size-4" />
                Create brain
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function HealthDot({ status }: { status?: string | null }) {
  const normalized = status || 'unknown'
  const colorMap: Record<string, string> = {
    online: 'bg-success',
    healthy: 'bg-success',
    active: 'bg-success',
    degraded: 'bg-warning',
    offline: 'bg-error',
    unhealthy: 'bg-error',
    unknown: 'bg-muted-foreground',
  }

  return <span className={cn('size-2 shrink-0 rounded-full', colorMap[normalized] || 'bg-muted-foreground')} title={normalized} />
}
