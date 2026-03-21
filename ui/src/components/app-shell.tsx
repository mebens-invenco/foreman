import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon, FolderTreeIcon, OrbitIcon } from "lucide-react";

import { SchedulerControls } from "@/components/scheduler-controls";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusBadge } from "@/components/status-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api, queryKeys } from "@/lib/api";
import { formatRelativeTimestamp } from "@/lib/format";
import { appPages, pageForPath } from "@/lib/navigation";

export function AppShell() {
  const location = useLocation();
  const currentPage = pageForPath(location.pathname);

  const statusQuery = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.fetchStatus,
    refetchInterval: 5000,
  });

  const workspaceName = statusQuery.data?.workspace.name ?? "Foreman";
  const workspaceRoot = statusQuery.data?.workspace.root ?? "Workspace root unavailable";
  const schedulerStatus = statusQuery.data?.scheduler.status;

  return (
    <TooltipProvider delayDuration={150}>
      <SidebarProvider defaultOpen>
        <Sidebar variant="inset" collapsible="icon" className="border-r border-sidebar-border/70">
          <SidebarHeader className="gap-4 border-b border-sidebar-border/70 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--sidebar)_96%,white_4%),color-mix(in_oklab,var(--sidebar)_86%,transparent))] p-4">
            <div className="border border-sidebar-border/70 bg-sidebar-accent/30 p-3 transition-all group-data-[collapsible=icon]:px-2.5 group-data-[collapsible=icon]:py-3">
              <div className="flex items-center gap-3">
                <div className="flex size-9 items-center justify-center border border-sidebar-border bg-sidebar-primary text-sidebar-primary-foreground">
                  <OrbitIcon className="size-4" />
                </div>
                <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-sidebar-foreground/60">Workspace</div>
                  <div className="mt-1 truncate font-heading text-base text-sidebar-foreground">{workspaceName}</div>
                </div>
              </div>
              <div className="mt-3 text-[11px] leading-5 text-sidebar-foreground/65 group-data-[collapsible=icon]:hidden">{workspaceRoot}</div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Command Center</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {appPages.map((page) => {
                    const Icon = page.icon;
                    const active = currentPage.path === page.path;

                    return (
                      <SidebarMenuItem key={page.path}>
                        <SidebarMenuButton asChild isActive={active} tooltip={page.label} className="px-3">
                          <NavLink to={page.path} end={page.path === "/"}>
                            <Icon className="size-4" />
                            <span>{page.label}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarSeparator />
          <SidebarFooter className="gap-3 p-4 text-[11px] leading-5 text-sidebar-foreground/70">
            <div className="border border-sidebar-border/70 bg-sidebar-accent/20 p-3 group-data-[collapsible=icon]:hidden">
              <div className="flex items-center justify-between gap-3">
                <span className="uppercase tracking-[0.18em]">Scheduler</span>
                {schedulerStatus ? <StatusBadge value={schedulerStatus} /> : null}
              </div>
              <div className="mt-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span>Repos</span>
                  <span className="text-sidebar-foreground">{statusQuery.data?.repos.count ?? 0}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>Next scout</span>
                  <span className="text-sidebar-foreground">
                    {statusQuery.data?.scheduler.nextScoutPollAt
                      ? formatRelativeTimestamp(statusQuery.data.scheduler.nextScoutPollAt)
                      : "Not scheduled"}
                  </span>
                </div>
              </div>
            </div>
            <div className="hidden items-center justify-center border border-sidebar-border/70 bg-sidebar-accent/20 p-2 group-data-[collapsible=icon]:flex">
              <FolderTreeIcon className="size-4" />
            </div>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-h-svh bg-transparent">
          <div className="min-h-svh bg-[radial-gradient(circle_at_top_left,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_30%),radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--chart-2)_12%,transparent),transparent_28%),linear-gradient(180deg,color-mix(in_oklab,var(--background)_96%,white_4%),var(--background))]">
            <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-xl">
              <div className="flex flex-col gap-4 px-4 py-4 md:px-6 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex items-start gap-3">
                  <SidebarTrigger className="mt-0.5" />
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">{currentPage.label}</div>
                    <div className="mt-1 text-xl font-heading text-foreground md:text-2xl">{currentPage.title}</div>
                    <div className="mt-1 max-w-2xl text-sm text-muted-foreground">{currentPage.description}</div>
                  </div>
                </div>
                <div className="flex flex-col gap-2 xl:items-end">
                  <div className="flex flex-wrap items-center gap-2">
                    <SchedulerControls status={schedulerStatus} />
                    <ThemeToggle />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{workspaceName}</span>
                    <ArrowUpRightIcon className="size-3" />
                    <span>{workspaceRoot}</span>
                  </div>
                </div>
              </div>
            </header>
            <main className="px-4 py-6 md:px-6 md:py-8">
              <Outlet />
            </main>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
