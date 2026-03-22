import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { LoadingState } from "@/components/states";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const OverviewPage = lazy(() => import("./pages/overview-page").then((module) => ({ default: module.OverviewPage })));
const AttemptsPage = lazy(() => import("./pages/attempts-page").then((module) => ({ default: module.AttemptsPage })));
const HistoryPage = lazy(() => import("./pages/history-page").then((module) => ({ default: module.HistoryPage })));
const LearningsPage = lazy(() => import("./pages/learnings-page").then((module) => ({ default: module.LearningsPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<div className="p-6"><LoadingState label="Loading page..." /></div>}>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<OverviewPage />} />
                <Route path="overview" element={<Navigate to="/" replace />} />
                <Route path="attempts" element={<AttemptsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="learnings" element={<LearningsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster richColors position="top-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
