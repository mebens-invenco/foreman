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
