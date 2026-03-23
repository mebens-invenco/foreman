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
