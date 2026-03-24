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
