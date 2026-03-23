import { Outlet } from "react-router"

import { AppSidebar } from "@/layouts/app-sidebar"
import { ShellTopBar } from "@/layouts/shell-top-bar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export function AppShell() {
  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset className="overflow-hidden border-l border-border/70 bg-background/95">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(15,23,42,0.07),transparent_24%)] dark:bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.16),transparent_24%),radial-gradient(circle_at_top_right,rgba(148,163,184,0.08),transparent_20%)]" />
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
