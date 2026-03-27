export function formatTimestamp(value: string | null) {
  if (!value) {
    return "pending"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "pending"
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

export function abbreviateId(value: string | null | undefined, visible = 5) {
  if (!value) {
    return "-"
  }

  if (value.length <= visible) {
    return value
  }

  return `*${value.slice(-visible)}`
}

export function formatActionLabel(value: string | null | undefined) {
  if (!value) {
    return "-"
  }

  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ")
}

export function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt || !finishedAt) {
    return "pending"
  }

  const start = new Date(startedAt).getTime()
  const end = new Date(finishedAt).getTime()

  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return "pending"
  }

  const totalSeconds = Math.floor((end - start) / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function formatRelativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) {
    return "pending"
  }

  const target = new Date(value).getTime()
  if (Number.isNaN(target)) {
    return "pending"
  }

  const seconds = Math.max(0, Math.floor((now - target) / 1000))
  if (seconds < 10) {
    return "just now"
  }
  if (seconds < 60) {
    return `${seconds}s ago`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }

  const weeks = Math.floor(days / 7)
  return `${weeks}w ago`
}
