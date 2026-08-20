export class RpcError extends Error {
  constructor(readonly code: string, readonly status: number = 400) {
    super(code);
    this.name = "RpcError";
  }
}
