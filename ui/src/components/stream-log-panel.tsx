import { useEffect, useMemo, useState } from "react";

import { connectLogStream } from "@/lib/log-stream";
import {
  appendLogChunk,
  appendSyntheticLogLine,
  createLogBuffer,
  getDisplayLines,
  type LogBuffer,
} from "@/lib/log-display";

import { ErrorState, LoadingState } from "@/components/states";
import { LogViewer } from "@/components/log-viewer";

type StreamLogPanelProps = {
  streamUrl: string | null;
  initialUrl?: string | null;
  emptyMessage?: string;
  includeAttemptChanges?: boolean;
};

const withStreamOffset = (url: string, offset: number): string => {
  if (offset <= 0) {
    return url;
  }

  const nextUrl = new URL(url, window.location.origin);
  nextUrl.searchParams.set("offset", String(offset));
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
};

export function StreamLogPanel({
  streamUrl,
  initialUrl = null,
  emptyMessage = "No logs yet.",
  includeAttemptChanges = false,
}: StreamLogPanelProps) {
  const [buffer, setBuffer] = useState<LogBuffer>(() => createLogBuffer());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lines = useMemo(() => getDisplayLines(buffer), [buffer]);

  useEffect(() => {
    let disposed = false;
    let disconnect = () => {};

    setBuffer(createLogBuffer());
    setError(null);

    if (!streamUrl && !initialUrl) {
      setLoading(false);
      return () => {};
    }

    const load = async () => {
      setLoading(true);
      let nextBuffer = createLogBuffer();
      let initialOffset = 0;

      if (initialUrl) {
        try {
          const response = await fetch(initialUrl);
          if (response.ok) {
            const text = await response.text();
            initialOffset = text.length;
            nextBuffer = appendLogChunk(nextBuffer, text);
            if (!disposed) {
              setBuffer(nextBuffer);
            }
          }
        } catch {
          // Let the stream continue even if the snapshot fetch fails.
        }
      }

      if (disposed || !streamUrl) {
        if (!disposed) {
          setLoading(false);
        }
        return;
      }

      const streamOptions = {
        streamUrl: withStreamOffset(streamUrl, initialOffset),
        onChunk: (chunk: string) => {
          setBuffer((current) => appendLogChunk(current, chunk));
        },
        onError: () => {
          if (!disposed) {
            setError("Live log stream disconnected.");
          }
        },
      };

      if (includeAttemptChanges) {
        disconnect = connectLogStream({
          ...streamOptions,
          onAttemptChanged: (attemptId) => {
            setBuffer((current) => appendSyntheticLogLine(current, attemptId ? `[worker switched to ${attemptId}]` : `[worker is idle]`));
          },
        });
      } else {
        disconnect = connectLogStream(streamOptions);
      }

      if (!disposed) {
        setLoading(false);
      }
    };

    void load();

    return () => {
      disposed = true;
      disconnect();
    };
  }, [includeAttemptChanges, initialUrl, streamUrl]);

  if (loading && lines.length === 0) {
    return <LoadingState label="Loading logs..." />;
  }

  if (error && lines.length === 0) {
    return <ErrorState label={error} />;
  }

  return (
    <div className="space-y-3">
      {error ? <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">{error}</div> : null}
      <LogViewer lines={lines} emptyMessage={emptyMessage} />
    </div>
  );
}
