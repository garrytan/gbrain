import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar, AuthGate, TopBar } from '@/components/cortex/shell'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthGate>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </AuthGate>
  )
}
