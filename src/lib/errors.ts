export class ForemanError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ForemanError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const isForemanError = (value: unknown): value is ForemanError =>
  value instanceof ForemanError;

export class ProviderRateLimitError extends ForemanError {
  readonly provider: string;
  readonly retryAfterSeconds: number;
  readonly resetAt: string;

  constructor(input: { provider: string; retryAfterSeconds: number; resetAt: string; message?: string }) {
    super(
      "provider_rate_limited",
      input.message ?? `${input.provider} provider rate limit exceeded; retry after ${input.resetAt}`,
      429,
    );
    this.provider = input.provider;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.resetAt = input.resetAt;
  }
}

export const isProviderRateLimitError = (value: unknown): value is ProviderRateLimitError =>
  value instanceof ProviderRateLimitError;

export class ProviderUnavailableError extends ForemanError {
  readonly provider: string;

  constructor(input: { provider: string; message: string; statusCode?: number }) {
    super("provider_unavailable", input.message, input.statusCode ?? 503);
    this.provider = input.provider;
  }
}

export const isProviderUnavailableError = (value: unknown): value is ProviderUnavailableError =>
  value instanceof ProviderUnavailableError;
