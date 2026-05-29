'use client'

import * as React from 'react'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'

import { api } from '@/lib/api'
import type { OrganizationSummary } from '@/lib/saas-model'
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

interface OrgSwitcherProps {
  className?: string
}

export function OrgSwitcher({ className }: OrgSwitcherProps) {
  const [open, setOpen] = React.useState(false)
  const [orgs, setOrgs] = React.useState<OrganizationSummary[]>([])
  const [selectedOrgId, setSelectedOrgId] = React.useState('')

  React.useEffect(() => {
    api.orgs()
      .then((rows: OrganizationSummary[]) => {
        setOrgs(rows)
        setSelectedOrgId((current) => current || rows[0]?.id || '')
      })
      .catch(() => undefined)
  }, [])

  const selectedOrg = orgs.find((org) => org.id === selectedOrgId)
  const label = selectedOrg?.name || 'Default org'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Select organization"
          className={cn('h-8 gap-2 px-2 font-normal', className)}
        >
          <div className="flex size-5 items-center justify-center rounded bg-primary text-xs font-medium text-primary-foreground">
            {label.charAt(0)}
          </div>
          <span className="max-w-[120px] truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search organization..." className="h-9" />
          <CommandList>
            <CommandEmpty>No organization found.</CommandEmpty>
            <CommandGroup heading="Organizations">
              {orgs.map((org) => (
                <CommandItem
                  key={org.id}
                  value={org.name}
                  onSelect={() => {
                    setSelectedOrgId(org.id)
                    setOpen(false)
                  }}
                  className="gap-2"
                >
                  <div className="flex size-5 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
                    {org.name.charAt(0)}
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{org.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{org.domain || org.slug}</span>
                  </div>
                  <Check className={cn('ml-auto size-4', selectedOrgId === org.id ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false)
                  window.location.href = '/admin/onboarding'
                }}
                className="gap-2"
              >
                <Plus className="size-4" />
                Create organization
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
