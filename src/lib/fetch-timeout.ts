export const PROVIDER_REQUEST_TIMEOUT_MS = 60_000;

export const createTimeoutSignal = (timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS, signals: AbortSignal[] = []): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signals.length === 0 ? timeoutSignal : AbortSignal.any([...signals, timeoutSignal]);
};

export const isAbortLikeError = (error: unknown): error is Error =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
