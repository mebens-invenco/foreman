import { Outlet } from "react-router"

import { AppSidebar } from "@/layouts/app-sidebar"
import { ShellTopBar } from "@/layouts/shell-top-bar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function AppShell() {
  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset className="m-0! overflow-hidden">
        <ShellTopBar />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
