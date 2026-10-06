export class AppError extends Error {
  public readonly timestamp: string;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: unknown,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.timestamp = new Date().toISOString();
  }
}
