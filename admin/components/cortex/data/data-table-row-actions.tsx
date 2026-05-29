'use client'

import { MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface DataTableRowActionsProps {
  actions: {
    label: string
    onClick: () => void
    destructive?: boolean
    disabled?: boolean
  }[]
}

export function DataTableRowActions({ actions }: DataTableRowActionsProps) {
  const regularActions = actions.filter((a) => !a.destructive)
  const destructiveActions = actions.filter((a) => a.destructive)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex size-8 p-0 data-[state=open]:bg-muted"
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Open menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[160px]">
        {regularActions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onClick={action.onClick}
            disabled={action.disabled}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
        {destructiveActions.length > 0 && regularActions.length > 0 && (
          <DropdownMenuSeparator />
        )}
        {destructiveActions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onClick={action.onClick}
            disabled={action.disabled}
            className="text-destructive focus:text-destructive"
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
