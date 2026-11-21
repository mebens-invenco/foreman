const FETCH_TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type FetchTransportErrorContext = {
  transportCauseName: string;
  transportCauseCode: string;
};

export const fetchTransportErrorContext = (error: unknown): FetchTransportErrorContext | null => {
  if (!(error instanceof TypeError) || error.message !== "fetch failed" || !(error.cause instanceof Error)) {
    return null;
  }

  const code = "code" in error.cause && typeof error.cause.code === "string" ? error.cause.code : null;
  if (!code || !FETCH_TRANSPORT_ERROR_CODES.has(code)) {
    return null;
  }

  return {
    transportCauseName: error.cause.name,
    transportCauseCode: code,
  };
};
