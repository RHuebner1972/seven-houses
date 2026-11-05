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

export const OFFLINE_COPY = "You're offline. Readings need a connection.";

/**
 * Turn a thrown value into something a person can read. Network failures (fetch's
 * TypeError, wrapped by the API client as code "network") never surface "Failed to fetch".
 */
export function describeError(e: unknown, fallback: string): { code: string; message: string } {
  if (e instanceof ApiError) {
    return { code: e.code, message: e.code === "network" ? OFFLINE_COPY : e.message };
  }
  if (e instanceof TypeError) return { code: "network", message: OFFLINE_COPY };
  return { code: "network", message: (e as Error | null)?.message || fallback };
}
