import {
  ActivityIcon,
  BookOpenTextIcon,
  BotIcon,
  ChartColumnIncreasingIcon,
  DollarSignIcon,
  ListTodoIcon,
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
    title: "Tasks",
    href: "/tasks",
    description: "One row per task — summed tokens, cost, and effective status across all attempts.",
    icon: ListTodoIcon,
  },
  {
    title: "Foreman",
    href: "/foreman",
    description: "Issue manager — every ready or agent-tagged issue, with a Foreman on/off toggle and frontmatter health.",
    icon: BotIcon,
  },
  {
    title: "Learnings",
    href: "/learnings",
    description: "Captured findings, recurring issues, and operational memory.",
    icon: BookOpenTextIcon,
  },
  {
    title: "Usage",
    href: "/usage",
    description: "Token usage and USD cost across attempts, by day, runner, or model.",
    icon: DollarSignIcon,
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
