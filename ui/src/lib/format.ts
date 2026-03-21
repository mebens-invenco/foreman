const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
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

const formatRelativeSeconds = (totalSeconds: number): string => {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m`;
  }

  return `${Math.floor(totalSeconds / 3600)}h`;
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
  return formatRelativeSeconds(totalSeconds);
};

export const formatHeartbeat = (value: string | null | undefined): string => {
  if (!value) {
    return "No heartbeat";
  }

  const timestamp = new Date(value).getTime();
  const secondsAgo = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return `${formatRelativeSeconds(secondsAgo)} ago`;
};

export const formatRelativeTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return "-";
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const secondsAgo = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return `${formatRelativeSeconds(secondsAgo)} ago`;
};

export const truncate = (value: string, length = 120): string => {
  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, Math.max(0, length - 1))}...`;
};

export const truncateMiddle = (value: string, edgeLength = 8): string => {
  if (value.length <= edgeLength * 2 + 3) {
    return value;
  }

  return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`;
};

export const formatNumber = (value: number): string => compactNumberFormatter.format(value);

export const formatCount = (value: number, singular: string, plural = `${singular}s`): string =>
  `${value} ${value === 1 ? singular : plural}`;

export const repoLabel = (value: string): string => value.split("/").filter(Boolean).pop() ?? value;

export const titleCase = (value: string): string =>
  value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
