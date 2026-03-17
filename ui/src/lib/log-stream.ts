export type LogStreamOptions = {
  streamUrl: string;
  onLine: (line: string) => void;
  onAttemptChanged?: (attemptId: string | null) => void;
  onError?: () => void;
};

export const connectLogStream = (options: LogStreamOptions): (() => void) => {
  const source = new EventSource(options.streamUrl);

  source.addEventListener("log", (event) => {
    if (event instanceof MessageEvent) {
      options.onLine(event.data);
    }
  });

  source.addEventListener("attempt_changed", (event) => {
    if (!(event instanceof MessageEvent) || !options.onAttemptChanged) {
      return;
    }

    try {
      const payload = JSON.parse(event.data) as { attemptId?: string | null };
      options.onAttemptChanged(payload.attemptId ?? null);
    } catch {
      options.onAttemptChanged(null);
    }
  });

  source.addEventListener("error", () => {
    options.onError?.();
  });

  return () => {
    source.close();
  };
};
