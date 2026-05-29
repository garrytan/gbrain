'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Brain,
  Database,
  Users,
  UserPlus,
  Bot,
  Gauge,
  KeyRound,
  Sparkles,
  Workflow,
  Activity,
  Settings,
  ChevronDown,
  LogOut,
  PlugZap,
  Rocket,
  FileText,
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'

// Icon mapping for dynamic rendering
const iconMap = {
  LayoutDashboard,
  Brain,
  Database,
  Users,
  UserPlus,
  Bot,
  Gauge,
  KeyRound,
  Sparkles,
  Workflow,
  Activity,
  Settings,
  PlugZap,
  Rocket,
  FileText,
}

// Navigation structure with clear grouping
const navigation = {
  main: [
    { label: 'Overview', href: '/overview', icon: 'LayoutDashboard' },
    { label: 'Onboarding', href: '/onboarding', icon: 'Rocket' },
    { label: 'Docs', href: '/docs', icon: 'FileText' },
    { label: 'Brains', href: '/brains', icon: 'Brain' },
    { label: 'Sources', href: '/sources', icon: 'Database' },
  ],
  management: [
    { label: 'Team', href: '/team', icon: 'Users' },
    { label: 'Invites', href: '/invites', icon: 'UserPlus' },
  ],
  integrations: [
    { label: 'Composio', href: '/integrations', icon: 'PlugZap' },
    { label: 'Agents', href: '/agents', icon: 'Bot' },
    { label: 'Skills', href: '/skills', icon: 'Sparkles' },
    { label: 'Runtime', href: '/runtime', icon: 'KeyRound' },
  ],
  operations: [
    { label: 'Jobs', href: '/jobs', icon: 'Workflow' },
    { label: 'Activity', href: '/activity', icon: 'Activity' },
    { label: 'Quality', href: '/quality', icon: 'Gauge' },
  ],
}

interface NavItemProps {
  item: { label: string; href: string; icon: string }
  isActive: boolean
}

function NavItem({ item, isActive }: NavItemProps) {
  const Icon = iconMap[item.icon as keyof typeof iconMap]
  
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <Link href={item.href}>
          <Icon className="size-4" />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const pathname = usePathname()
  const { state } = useSidebar()
  const isCollapsed = state === 'collapsed'
  const signOut = () => {
    api.signOutEverywhere().catch(() => undefined).finally(() => {
      window.location.href = '/admin/login'
    })
  }

  const isActive = (href: string) => {
    if (href === '/overview') {
      return pathname === '/' || pathname === '/overview'
    }
    return pathname.startsWith(href)
  }

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-1">
          <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Brain className="size-4" />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-sidebar-foreground">
                Cortex Brain
              </span>
              <span className="text-xs text-sidebar-foreground/60">
                Multi-tenant SaaS
              </span>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Main navigation */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.main.map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Management */}
        <SidebarGroup>
          <SidebarGroupLabel>Management</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.management.map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Integrations */}
        <SidebarGroup>
          <SidebarGroupLabel>Integrations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.integrations.map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Operations */}
        <SidebarGroup>
          <SidebarGroupLabel>Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.operations.map((item) => (
                <NavItem
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Settings - at bottom of content */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem
                item={{ label: 'Settings', href: '/settings', icon: 'Settings' }}
                isActive={isActive('/settings')}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="w-full">
                  <Avatar className="size-6">
                    <AvatarFallback className="text-xs bg-sidebar-accent text-sidebar-accent-foreground">
                      CT
                    </AvatarFallback>
                  </Avatar>
                  {!isCollapsed && (
                    <>
                      <div className="flex flex-col items-start text-left">
                        <span className="text-sm font-medium truncate max-w-[140px]">
                          Cortex Admin
                        </span>
                        <span className="text-xs text-sidebar-foreground/60 truncate max-w-[140px]">
                          Secure console
                        </span>
                      </div>
                      <ChevronDown className="ml-auto size-4 opacity-50" />
                    </>
                  )}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
              >
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="mr-2 size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={signOut}>
                  <LogOut className="mr-2 size-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
