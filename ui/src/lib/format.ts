const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return dateTimeFormatter.format(date);
};

export const formatDuration = (startedAt: string | null | undefined, finishedAt: string | null | undefined): string => {
  if (!startedAt) {
    return "-";
  }

  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

export const formatHeartbeat = (value: string | null | undefined): string => {
  if (!value) {
    return "No heartbeat";
  }

  const timestamp = new Date(value).getTime();
  const secondsAgo = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (secondsAgo < 60) {
    return `${secondsAgo}s ago`;
  }

  const minutes = Math.floor(secondsAgo / 60);
  return `${minutes}m ago`;
};

export const truncate = (value: string, length = 120): string => {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, Math.max(0, length - 1))}...`;
};
