export class WanxError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code); this.name = "WanxError";
  }
}
