export const isoNow = (): string => new Date().toISOString();

export const addSeconds = (value: string | Date, seconds: number): string => {
  const date = typeof value === "string" ? new Date(value) : new Date(value);
  return new Date(date.getTime() + seconds * 1000).toISOString();
};

export const addMilliseconds = (value: string | Date, ms: number): string => {
  const date = typeof value === "string" ? new Date(value) : new Date(value);
  return new Date(date.getTime() + ms).toISOString();
};

export const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
