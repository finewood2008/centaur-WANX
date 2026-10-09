export class SelectionGuard {
  select(key: string): void;
  begin(key: string): () => boolean;
  invalidate(): void;
}
