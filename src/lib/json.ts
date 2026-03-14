export const stableStringify = (value: unknown): string =>
  JSON.stringify(sortValue(value));

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
  }

  return value;
};
