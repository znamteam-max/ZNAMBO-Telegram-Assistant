export class UserFacingError extends Error {
  constructor(
    message: string,
    public readonly code = "user_error",
  ) {
    super(message);
  }
}

export class ExternalServiceError extends Error {
  constructor(
    message: string,
    public readonly service: "telegram" | "openai" | "google" | "database",
    public readonly retryable = true,
  ) {
    super(message);
  }
}
