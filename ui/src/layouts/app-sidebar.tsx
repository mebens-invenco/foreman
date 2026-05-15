import { Link, useLocation } from "react-router"
import { OrbitIcon, RotateCcwIcon } from "lucide-react"

import { getNavigationItem, navigationItems } from "@/app/navigation"
import { useStatusQuery } from "@/hooks/use-status-query"
import { useSystemRebootMutation } from "@/hooks/use-system-reboot-mutation"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"

export function AppSidebar() {
  const location = useLocation()
  const activeItem = getNavigationItem(location.pathname)
  const { data: status, isLoading } = useStatusQuery()
  const rebootMutation = useSystemRebootMutation()

  const handleRestartClick = () => {
    if (
      !window.confirm(
        "Restart Foreman now? The UI may disconnect briefly while the process restarts."
      )
    ) {
      return
    }

    rebootMutation.mutate()
  }

  const isRestarting = rebootMutation.isPending || rebootMutation.isSuccess

  return (
    <Sidebar
      variant="inset"
      collapsible="icon"
      className="border-r border-sidebar-border/80"
    >
      <SidebarHeader>
        <SidebarGroup className="gap-4">
          <div className="flex items-center gap-3 group-data-[collapsible=icon]:px-0">
            <div className="flex size-9 items-center justify-center rounded-none border border-sidebar-border bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
              <OrbitIcon className="size-4" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="text-xxs tracking-[0.3em] text-sidebar-foreground/55 uppercase">
                Foreman
              </p>
              {isLoading ? (
                <Skeleton className="mt-2 h-4 w-32 rounded-none bg-sidebar-accent" />
              ) : (
                <p className="truncate text-sm text-sidebar-foreground">
                  {status?.workspace.name ?? "Workspace"}
                </p>
              )}
            </div>
          </div>
        </SidebarGroup>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map((item) => {
                const isActive = activeItem?.href === item.href

                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.title}
                    >
                      <Link to={item.href}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="gap-4 px-3 py-4">
        <SidebarSeparator />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-sidebar-foreground/75 hover:text-sidebar-accent-foreground disabled:opacity-60"
              disabled={isRestarting}
              onClick={handleRestartClick}
              tooltip="Restart Foreman"
            >
              <RotateCcwIcon className={isRestarting ? "animate-spin" : undefined} />
              <span>{isRestarting ? "Restarting..." : "Restart Foreman"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="space-y-2 px-2 text-xs leading-5 text-sidebar-foreground/65 group-data-[collapsible=icon]:hidden">
          <p>
            {status ? `${status.repos.count} repos` : "Inspecting workspace..."}
          </p>
          {status ? <p className="truncate">{status.workspace.root}</p> : null}
          {status ? (
            <p className="flex min-w-0 items-center gap-2">
              <span className="truncate">
                {status.version.shortCommit
                  ? `Foreman ${status.version.shortCommit}`
                  : "Version unknown"}
              </span>
              {status.version.updateAvailable ? (
                <span className="shrink-0 text-destructive">Update available</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
