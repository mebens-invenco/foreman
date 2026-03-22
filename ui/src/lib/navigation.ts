import type { LucideIcon } from "lucide-react";
import { ActivitySquareIcon, BrainCircuitIcon, Clock3Icon, LayoutDashboardIcon } from "lucide-react";

export type AppPage = {
  path: "/" | "/attempts" | "/history" | "/learnings";
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

export const appPages: AppPage[] = [
  {
    path: "/",
    label: "Overview",
    title: "Operational overview",
    description: "Monitor workers, queue pressure, review-ready work, and recent repo history.",
    icon: LayoutDashboardIcon,
  },
  {
    path: "/attempts",
    label: "Attempts",
    title: "Attempt ledger",
    description: "Filter execution attempts, inspect events, and stream logs without leaving the page.",
    icon: ActivitySquareIcon,
  },
  {
    path: "/history",
    label: "History",
    title: "Execution history",
    description: "Search durable task history and inspect repo transitions captured at each stage.",
    icon: Clock3Icon,
  },
  {
    path: "/learnings",
    label: "Learnings",
    title: "Shared learnings",
    description: "Search reusable repo knowledge and drill into the content that guided recent work.",
    icon: BrainCircuitIcon,
  },
];

export const fallbackPage = appPages[0]!;

export function pageForPath(pathname: string): AppPage {
  if (pathname === "/overview") {
    return fallbackPage;
  }

  return appPages.find((page) => page.path === pathname) ?? fallbackPage;
}
