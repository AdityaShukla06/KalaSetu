export type BackgroundRemovalFailureReason = "not_configured" | "timeout" | "provider_error";

export class BackgroundRemovalError extends Error {
  public readonly reason: BackgroundRemovalFailureReason;
  public readonly cause?: unknown;

  constructor(reason: BackgroundRemovalFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = "BackgroundRemovalError";
    this.reason = reason;
    this.cause = cause;
  }
}
