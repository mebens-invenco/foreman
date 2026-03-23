import { Navigate, Route, Routes } from "react-router"

import { defaultRoute, navigationItems } from "@/app/navigation"
import { AppShell } from "@/layouts/app-shell"
import { AttemptsPage } from "@/pages/attempts"
import { HistoryPage } from "@/pages/history"
import { LearningsPage } from "@/pages/learnings"
import { NotFoundPage } from "@/pages/not-found"
import { OverviewPage } from "@/pages/overview"

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={defaultRoute} replace />} />
      <Route element={<AppShell />}>
        <Route path={navigationItems[0].href} element={<OverviewPage />} />
        <Route path={navigationItems[1].href} element={<AttemptsPage />} />
        <Route path={navigationItems[2].href} element={<HistoryPage />} />
        <Route path={navigationItems[3].href} element={<LearningsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
