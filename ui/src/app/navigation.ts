import {
  ActivityIcon,
  BookOpenTextIcon,
  ChartColumnIncreasingIcon,
  Clock3Icon,
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
    title: "History",
    href: "/history",
    description: "Execution history, outcomes, and searchable prior runs.",
    icon: Clock3Icon,
  },
  {
    title: "Learnings",
    href: "/learnings",
    description: "Captured findings, recurring issues, and operational memory.",
    icon: BookOpenTextIcon,
  },
]

export const defaultRoute = navigationItems[0].href

export function getNavigationItem(pathname: string) {
  return navigationItems.find((item) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`)
  )
}
