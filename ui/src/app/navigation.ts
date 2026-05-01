import {
  ActivityIcon,
  BookOpenTextIcon,
  ChartColumnIncreasingIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react"

export type NavigationItem = {
  title: string
  href: string
  description: string
  icon: LucideIcon
}

export const navigationItems: NavigationItem[] = [
  {
    title: "Overview",
    href: "/overview",
    description: "Workspace health, scheduler status, and integration posture.",
    icon: ChartColumnIncreasingIcon,
  },
  {
    title: "Attempts",
    href: "/attempts",
    description: "Active execution flow, live state, and streaming log surfaces.",
    icon: ActivityIcon,
  },
  {
    title: "Learnings",
    href: "/learnings",
    description: "Captured findings, recurring issues, and operational memory.",
    icon: BookOpenTextIcon,
  },
  {
    title: "Settings",
    href: "/settings",
    description: "Cron scheduling and agent task creation controls.",
    icon: SlidersHorizontalIcon,
  },
]

export const defaultRoute = navigationItems[0].href

export function getNavigationItem(pathname: string) {
  return navigationItems.find((item) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`)
  )
}
