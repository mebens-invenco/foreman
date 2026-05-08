import type { MouseEvent, ReactNode } from "react"

import { cn } from "@/lib/utils"

type TaskLinkProps = {
  taskUrl: string | null
  children: ReactNode
  className?: string
  title?: string
}

export function TaskLink({ taskUrl, children, className, title }: TaskLinkProps) {
  if (!taskUrl) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    )
  }

  return (
    <a
      href={taskUrl}
      target="_blank"
      rel="noreferrer"
      className={cn(
        className,
        "underline-offset-4 hover:text-primary hover:underline"
      )}
      title={title}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
    >
      {children}
    </a>
  )
}
