export class RpcError extends Error {
  constructor(readonly code: string, readonly status: number = 400, readonly detail?: string) {
    super(code);
    this.name = "RpcError";
  }
}

export function isRpcError(err: unknown): err is RpcError {
  if (err instanceof RpcError) return true;
  if (!err || typeof err !== "object") return false;
  const candidate = err as { name?: unknown; code?: unknown; status?: unknown };
  return (
    candidate.name === "RpcError" &&
    typeof candidate.code === "string" &&
    typeof candidate.status === "number"
  );
}

