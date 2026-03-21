import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CheckCircle2Icon, GitPullRequestArrowIcon, Layers3Icon, OrbitIcon, Rows2Icon, Users2Icon } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { DetailSheet } from "@/components/detail-sheet";
import { MetricCard } from "@/components/metric-card";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { StreamLogPanel } from "@/components/stream-log-panel";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, queryKeys, type QueueJob, type TaskListItem, type Worker } from "@/lib/api";
import { formatHeartbeat, formatRelativeTimestamp, formatTimestamp, repoLabel, truncate, truncateMiddle } from "@/lib/format";

const RECENT_HISTORY_LIMIT = 6;

export function OverviewPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedWorkerId = searchParams.get("worker");

  const updateParams = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next);
  };

  const statusQuery = useQuery({
    queryKey: queryKeys.status,
    queryFn: api.fetchStatus,
    refetchInterval: 5000,
  });

  const workersQuery = useQuery({
    queryKey: queryKeys.workers,
    queryFn: api.listWorkers,
    refetchInterval: 5000,
  });

  const queueQuery = useQuery({
    queryKey: queryKeys.queue,
    queryFn: api.listQueue,
    refetchInterval: 5000,
  });

  const reviewTasksQuery = useQuery({
    queryKey: queryKeys.tasks({ state: "in_review", limit: 8 }),
    queryFn: () => api.listTasks({ state: "in_review", limit: 8 }),
    refetchInterval: 10000,
  });

  const recentHistoryQuery = useQuery({
    queryKey: queryKeys.history({ limit: RECENT_HISTORY_LIMIT, offset: 0 }),
    queryFn: () => api.listHistory({ limit: RECENT_HISTORY_LIMIT, offset: 0 }),
    refetchInterval: 10000,
  });

  const status = statusQuery.data;
  const workers = workersQuery.data ?? [];
  const queueJobs = queueQuery.data ?? [];
  const reviewTasks = reviewTasksQuery.data ?? [];
  const recentHistory = recentHistoryQuery.data ?? [];
  const selectedWorker = workers.find((worker) => worker.id === selectedWorkerId) ?? null;

  const activeWorkers = workers.filter((worker) => worker.currentJob).length;
  const healthyWorkers = workers.filter((worker) => worker.status !== "offline").length;

  const metrics = useMemo(
    () => [
      {
        eyebrow: "Workers online",
        value: `${healthyWorkers}/${workers.length || 0}`,
        detail: activeWorkers > 0 ? `${activeWorkers} currently executing work.` : "No workers are actively executing right now.",
        icon: <Users2Icon className="size-5" />,
      },
      {
        eyebrow: "Queue depth",
        value: String(queueJobs.length),
        detail: queueJobs.length > 0 ? `Highest priority job is ${queueJobs[0]?.taskId}.` : "The execution queue is empty.",
        icon: <Rows2Icon className="size-5" />,
      },
      {
        eyebrow: "Needs review",
        value: String(reviewTasks.length),
        detail: reviewTasks.length > 0 ? `${reviewTasks[0]?.id} is the freshest review item.` : "No tasks are currently waiting on review.",
        icon: <GitPullRequestArrowIcon className="size-5" />,
      },
      {
        eyebrow: "Tracked repos",
        value: String(status?.repos.count ?? 0),
        detail: status?.repos.keys.length ? status.repos.keys.slice(0, 3).join(", ") : "No repos configured.",
        icon: <Layers3Icon className="size-5" />,
      },
    ],
    [activeWorkers, healthyWorkers, queueJobs, reviewTasks, status?.repos.count, status?.repos.keys],
  );

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="border border-border/80 bg-card/75 backdrop-blur-sm">
          <CardHeader className="border-b border-border/60">
            <CardTitle>Operational pulse</CardTitle>
            <CardDescription>Live scheduler health, workspace scope, and integration state.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 pt-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            {statusQuery.isPending && !status ? (
              <LoadingState label="Loading workspace status..." />
            ) : statusQuery.isError ? (
              <ErrorState label={statusQuery.error instanceof Error ? statusQuery.error.message : "Failed to load workspace status."} />
            ) : status ? (
              <>
                <div className="space-y-4 border border-border/70 bg-background/60 p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Workspace</div>
                      <div className="mt-2 text-2xl font-heading text-foreground">{status.workspace.name}</div>
                      <div className="mt-2 text-sm text-muted-foreground">{status.workspace.root}</div>
                    </div>
                    <div className="flex size-11 items-center justify-center border border-border/70 bg-primary/10 text-primary">
                      <OrbitIcon className="size-5" />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="border border-border/70 bg-card/80 p-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Scheduler</div>
                      <div className="mt-2 flex items-center gap-2">
                        <StatusBadge value={status.scheduler.status} />
                        <span className="text-sm text-muted-foreground">{status.scheduler.workerConcurrency} slots</span>
                      </div>
                    </div>
                    <div className="border border-border/70 bg-card/80 p-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Scout cadence</div>
                      <div className="mt-2 text-sm text-foreground">Every {status.scheduler.scoutPollIntervalSeconds}s</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Next {status.scheduler.nextScoutPollAt ? formatRelativeTimestamp(status.scheduler.nextScoutPollAt) : "not scheduled"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  {[
                    { label: "Task system", type: status.integrations.taskSystem.type, value: status.integrations.taskSystem.status },
                    { label: "Review system", type: status.integrations.reviewSystem.type, value: status.integrations.reviewSystem.status },
                    { label: "Runner", type: status.integrations.runner.type, value: status.integrations.runner.status },
                  ].map((integration) => (
                    <div key={integration.label} className="border border-border/70 bg-background/60 p-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{integration.label}</div>
                          <div className="mt-1 text-sm text-foreground">{integration.type}</div>
                        </div>
                        <StatusBadge value={integration.value} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          {metrics.map((metric) => (
            <MetricCard key={metric.eyebrow} {...metric} />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Worker overview</div>
          <div className="mt-1 text-lg font-heading text-foreground">Live worker detail with direct log access</div>
        </div>
        {workersQuery.isPending && workers.length === 0 ? (
          <LoadingState label="Loading workers..." />
        ) : workersQuery.isError ? (
          <ErrorState label={workersQuery.error instanceof Error ? workersQuery.error.message : "Failed to load workers."} />
        ) : workers.length === 0 ? (
          <EmptyState label="No workers available." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {workers.map((worker) => (
              <button
                key={worker.id}
                type="button"
                className="group border border-border/80 bg-card/75 p-4 text-left transition hover:-translate-y-0.5 hover:bg-card"
                onClick={() => updateParams({ worker: worker.id })}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Worker {worker.slot}</div>
                    <div className="mt-2 font-mono text-xs text-foreground">{worker.id}</div>
                  </div>
                  <StatusBadge value={worker.status} />
                </div>
                <div className="mt-4 min-h-16 space-y-2 text-sm text-muted-foreground">
                  {worker.currentJob ? (
                    <>
                      <div className="text-foreground">{worker.currentJob.taskId}</div>
                      <div>{worker.currentJob.action} · {worker.currentJob.repoKey}</div>
                      <div className="font-mono text-xs">{worker.currentAttempt?.id ?? worker.currentAttemptId}</div>
                    </>
                  ) : (
                    <div>Idle and ready for the next lease.</div>
                  )}
                </div>
                <div className="mt-5 flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  <span>Heartbeat {formatHeartbeat(worker.lastHeartbeatAt)}</span>
                  <ArrowRightIcon className="size-3 transition group-hover:translate-x-0.5" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <SectionCard title="Active queue" description="Up to eight queued jobs with repo and action context.">
          <QueueList jobs={queueJobs.slice(0, 8)} pending={queueQuery.isPending && queueJobs.length === 0} error={queueQuery.isError ? (queueQuery.error instanceof Error ? queueQuery.error.message : "Failed to load queue.") : null} />
        </SectionCard>

        <SectionCard title="Needs review" description="Current review-focused work summary across task targets.">
          <ReviewTaskList tasks={reviewTasks} pending={reviewTasksQuery.isPending && reviewTasks.length === 0} error={reviewTasksQuery.isError ? (reviewTasksQuery.error instanceof Error ? reviewTasksQuery.error.message : "Failed to load review tasks.") : null} />
        </SectionCard>

        <SectionCard
          title="Recent history"
          description="Compact repo history snapshots instead of scout-run activity."
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => navigate("/history")}>
              View all
            </Button>
          }
        >
          {recentHistoryQuery.isPending && recentHistory.length === 0 ? (
            <LoadingState label="Loading recent history..." />
          ) : recentHistoryQuery.isError ? (
            <ErrorState label={recentHistoryQuery.error instanceof Error ? recentHistoryQuery.error.message : "Failed to load recent history."} />
          ) : recentHistory.length === 0 ? (
            <EmptyState label="No history entries recorded yet." />
          ) : (
            <div className="space-y-3">
              {recentHistory.map((record) => (
                <button
                  key={record.stepId}
                  type="button"
                  className="w-full border border-border/70 bg-background/60 p-4 text-left transition hover:border-primary/40 hover:bg-background"
                  onClick={() => navigate(`/history?selected=${record.stepId}`)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <StatusBadge value={record.stage} />
                    <Timestamp value={record.createdAt} mode="relative" className="text-xs text-muted-foreground" />
                  </div>
                  <div className="mt-3 text-sm font-medium text-foreground">{record.issue}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{truncate(record.summary, 96)}</div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    {record.repos.length === 0 ? <span>No repos</span> : record.repos.map((repo) => <span key={`${record.stepId}-${repo.path}`}>{repoLabel(repo.path)}</span>)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </SectionCard>
      </section>

      <DetailSheet
        open={Boolean(selectedWorker)}
        onOpenChange={(open) => {
          if (!open) {
            updateParams({ worker: null });
          }
        }}
        title={selectedWorker ? `Worker ${selectedWorker.slot}` : "Worker"}
        description="Live worker status, current lease details, and rolling log stream with attempt switches preserved."
      >
        {selectedWorker ? (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <MetricCard eyebrow="Status" value={selectedWorker.status} detail="Current worker lifecycle state." />
              <MetricCard eyebrow="Heartbeat" value={formatHeartbeat(selectedWorker.lastHeartbeatAt)} detail={formatTimestamp(selectedWorker.lastHeartbeatAt)} />
              <MetricCard eyebrow="Attempt" value={selectedWorker.currentAttemptId ? truncateMiddle(selectedWorker.currentAttemptId, 6) : "idle"} detail={selectedWorker.currentJob?.taskId ?? "No leased task."} />
            </div>

            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Worker detail</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-4 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-3"><span>Worker ID</span><span className="font-mono text-xs text-foreground">{selectedWorker.id}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Task</span><span className="text-foreground">{selectedWorker.currentJob?.taskId ?? "-"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Action</span><span className="text-foreground">{selectedWorker.currentJob?.action ?? "-"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Repo</span><span className="text-foreground">{selectedWorker.currentJob?.repoKey ?? "-"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Started</span><span className="text-foreground">{selectedWorker.currentAttempt?.startedAt ? formatRelativeTimestamp(selectedWorker.currentAttempt.startedAt) : "-"}</span></div>
              </CardContent>
            </Card>

            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Live log</CardTitle>
                <CardDescription>Worker streams continue across attempt changes and insert explicit boundary markers.</CardDescription>
              </CardHeader>
              <CardContent className="pt-4">
                <StreamLogPanel streamUrl={`/api/workers/${selectedWorker.id}/logs/stream`} emptyMessage="Worker has not produced logs yet." includeAttemptChanges />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DetailSheet>
    </div>
  );
}

type SectionCardProps = {
  title: string;
  description: string;
  children: React.ReactNode;
  action?: React.ReactNode;
};

function SectionCard({ title, description, children, action }: SectionCardProps) {
  return (
    <Card className="border border-border/80 bg-card/75 backdrop-blur-sm">
      <CardHeader className="border-b border-border/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

type QueueListProps = {
  jobs: QueueJob[];
  pending: boolean;
  error: string | null;
};

function QueueList({ jobs, pending, error }: QueueListProps) {
  if (pending) {
    return <LoadingState label="Loading queue..." />;
  }

  if (error) {
    return <ErrorState label={error} />;
  }

  if (jobs.length === 0) {
    return <EmptyState label="Queue is empty." />;
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <div key={job.id} className="border border-border/70 bg-background/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-mono text-xs text-foreground">{job.taskId}</div>
              <div className="mt-1 text-sm text-muted-foreground">{job.repoKey}</div>
            </div>
            <StatusBadge value={job.action} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>Priority {job.priorityRank}</span>
            <Timestamp value={job.createdAt} mode="relative" className="text-xs text-muted-foreground" />
          </div>
        </div>
      ))}
    </div>
  );
}

type ReviewTaskListProps = {
  tasks: TaskListItem[];
  pending: boolean;
  error: string | null;
};

function ReviewTaskList({ tasks, pending, error }: ReviewTaskListProps) {
  if (pending) {
    return <LoadingState label="Loading review tasks..." />;
  }

  if (error) {
    return <ErrorState label={error} />;
  }

  if (tasks.length === 0) {
    return <EmptyState label="No tasks are in review right now." />;
  }

  return (
    <div className="space-y-3">
      {tasks.map((task) => {
        const primaryTarget = task.targets[0] ?? null;
        const multiTarget = task.targets.length > 1;

        return (
          <div key={task.id} className="border border-border/70 bg-background/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-xs text-foreground">{task.id}</div>
              <StatusBadge value={task.state} />
            </div>
            <div className="mt-2 text-sm text-foreground">{task.title}</div>
            {multiTarget ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {task.targets.map((target) => (
                  <div key={target.id} className="border border-border/70 bg-card/60 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-[11px] text-foreground">{target.repoKey}</div>
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{target.branchName}</div>
                      </div>
                      <StatusBadge value={target.status} />
                    </div>
                    {target.review?.pullRequestUrl ? (
                      <a className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline" href={target.review.pullRequestUrl} rel="noreferrer" target="_blank">
                        PR {target.review.pullRequestNumber}
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>{primaryTarget?.repoKey ?? task.repo ?? "No repo"}</span>
                {primaryTarget?.review?.pullRequestUrl ? (
                  <a className="inline-flex items-center gap-1 text-primary hover:underline" href={primaryTarget.review.pullRequestUrl} rel="noreferrer" target="_blank">
                    PR {primaryTarget.review.pullRequestNumber}
                  </a>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
