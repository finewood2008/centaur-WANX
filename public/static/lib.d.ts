export declare const esc: (s: unknown) => string;
export declare function md(src: unknown): string;
export declare function extractListItems(src: unknown): Array<{ text: string; done: boolean }>;
export declare function extractTables(
  src: unknown,
): Array<{ head: string[]; rows: string[][] }>;
export declare function sseFrames(
  response: { body: ReadableStream<Uint8Array> | null },
): AsyncGenerator<{ event: string; data: any }>;
