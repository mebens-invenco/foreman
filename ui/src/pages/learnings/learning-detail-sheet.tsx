import type { ReactNode } from "react"

import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { MarkdownView } from "@/components/markdown-view"
import { formatTimestamp } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { LearningRecord } from "@/lib/api"
import {
  confidenceTone,
  LearningArchivedBadge,
  LearningDuplicateBadge,
} from "@/pages/learnings/columns"

type LearningDetailSheetProps = {
  learning: LearningRecord | null
  onSelectLearning: (learningId: string) => void
  onSetArchived: (learningId: string, archived: boolean) => void
  isUpdatingArchive: boolean
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-border/70 bg-background/70 px-4 py-3">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        {label}
      </p>
      <div className="mt-2 text-sm leading-6 break-all text-foreground">
        {value}
      </div>
    </div>
  )
}

function LearningConfidenceBadge({
  confidence,
}: {
  confidence: LearningRecord["confidence"]
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
        confidenceTone(confidence)
      )}
    >
      {confidence}
    </span>
  )
}

function DuplicateOfLink({
  duplicateOf,
  onSelectLearning,
}: {
  duplicateOf: string
  onSelectLearning: (learningId: string) => void
}) {
  return (
    <button
      type="button"
      className="font-mono underline underline-offset-4 hover:text-muted-foreground"
      onClick={() => onSelectLearning(duplicateOf)}
    >
      {duplicateOf}
    </button>
  )
}

export function LearningDetailSheet({
  learning,
  onSelectLearning,
  onSetArchived,
  isUpdatingArchive,
}: LearningDetailSheetProps) {
  return (
    <SheetContent
      side="right"
      className="data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(60rem,calc(100vw-2rem))] data-[side=right]:sm:max-w-[min(60rem,calc(100vw-2rem))] data-[side=right]:xl:w-[min(72rem,calc(100vw-4rem))] data-[side=right]:xl:max-w-[min(72rem,calc(100vw-4rem))]"
    >
      <SheetHeader className="border-b border-border/70 pr-12">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <SheetTitle>{learning?.title ?? "Learning"}</SheetTitle>
            <SheetDescription className="mt-2 font-mono text-xs text-muted-foreground">
              {learning?.id ?? "No learning selected"}
            </SheetDescription>
          </div>
          {learning ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {learning.duplicateOf ? <LearningDuplicateBadge /> : null}
              {learning.archivedAt ? <LearningArchivedBadge /> : null}
              <LearningConfidenceBadge confidence={learning.confidence} />
              <Button
                size="sm"
                variant="outline"
                disabled={isUpdatingArchive}
                onClick={() =>
                  onSetArchived(learning.id, learning.archivedAt === null)
                }
              >
                {learning.archivedAt ? "Unarchive" : "Archive"}
              </Button>
            </div>
          ) : null}
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
        {learning ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DetailRow label="Repo" value={learning.repo} />
              <DetailRow label="Applied" value={learning.appliedCount} />
              <DetailRow label="Reads" value={learning.readCount} />
              <DetailRow label="Confidence" value={learning.confidence} />
              <DetailRow label="Created" value={formatTimestamp(learning.createdAt)} />
              <DetailRow label="Updated" value={formatTimestamp(learning.updatedAt)} />
              <DetailRow label="Source task" value={learning.sourceTaskId ?? "-"} />
              {learning.archivedAt ? (
                <DetailRow
                  label="Archived"
                  value={formatTimestamp(learning.archivedAt)}
                />
              ) : null}
              {learning.duplicateOf ? (
                <DetailRow
                  label="Duplicate of"
                  value={
                    <DuplicateOfLink
                      duplicateOf={learning.duplicateOf}
                      onSelectLearning={onSelectLearning}
                    />
                  }
                />
              ) : null}
            </section>

            <section className="space-y-2">
              <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
                Tags
              </p>
              {learning.tags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {learning.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex rounded-none border border-border/70 bg-background/70 px-2 py-1 text-xxs tracking-[0.18em] text-foreground uppercase"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">-</p>
              )}
            </section>

            <section className="border border-border/70 bg-background/70 px-4 py-3">
              <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
                Learning
              </p>
              <MarkdownView className="mt-2">{learning.content}</MarkdownView>
            </section>
          </>
        ) : null}
      </div>
    </SheetContent>
  )
}
