import { Navigate, Route, Routes } from "react-router"

import { defaultRoute, navigationItems } from "@/app/navigation"
import { AppShell } from "@/layouts/app-shell"
import { AttemptsPage } from "@/pages/attempts"
import { LearningsPage } from "@/pages/learnings"
import { NotFoundPage } from "@/pages/not-found"
import { OverviewPage } from "@/pages/overview"
import { SettingsPage } from "@/pages/settings"
import { UsagePage } from "@/pages/usage"
import { WorkItemsPage } from "@/pages/work-items"

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={defaultRoute} replace />} />
      <Route element={<AppShell />}>
        <Route path={navigationItems[0].href} element={<OverviewPage />} />
        <Route path={navigationItems[1].href} element={<AttemptsPage />} />
        <Route path={navigationItems[2].href} element={<WorkItemsPage />} />
        <Route path={navigationItems[3].href} element={<LearningsPage />} />
        <Route path={navigationItems[4].href} element={<UsagePage />} />
        <Route path={navigationItems[5].href} element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
