export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isCode(e: unknown, code: string): e is ApiError {
  return e instanceof ApiError && e.code === code;
}
