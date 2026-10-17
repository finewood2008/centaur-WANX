export interface DriveEntry {
  id: string;
  parent: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  modified: number;
  trashed: number | null;
  digest: string | null;
}
export interface DriveListing {
  items: DriveEntry[];
  breadcrumbs: {id: string; name: string}[];
  parent: string;
}
export interface DriveUpload {
  id: string;
  parent: string;
  name: string;
  size: number;
  offset: number;
  state: 'pending' | 'complete';
  modified: number;
}
export interface DriveOverview {
  protocolVersion: number;
  chunkSize: number;
  collectedAt: number;
  filesBytes: number;
  pendingBytes: number;
  volume: {scope: string; total: number; used: number; free: number};
  memory: {scope: string; total: number; used: number; percent: number} | null;
  cpu: {scope: string; percent: number} | null;
  container: boolean;
}
interface Options {signal?: AbortSignal}
interface FolderInput extends Options {name: string; parent?: string}
export interface DriveClient {
  overview(options?: Options): Promise<DriveOverview>;
  list(options?: Options & {parent?: string; trash?: boolean}): Promise<DriveListing>;
  stat(id: string, options?: Options): Promise<DriveEntry>;
  mkdir(input: FolderInput): Promise<DriveEntry>;
  move(input: FolderInput & {id: string}): Promise<DriveEntry>;
  trash(id: string, options?: Options): Promise<void>;
  restore(id: string, options?: Options): Promise<DriveEntry>;
  purge(id: string, options?: Options): Promise<void>;
  createUpload(input: FolderInput & {uploadId: string; size: number}): Promise<DriveUpload>;
  uploadStatus(uploadId: string, options?: Options): Promise<DriveUpload>;
  writeChunk(uploadId: string, input: Options & {offset: number; data: Uint8Array}): Promise<{offset: number}>;
  completeUpload(uploadId: string, input: Options & {digest: string}): Promise<DriveEntry>;
  cancelUpload(uploadId: string, options?: Options): Promise<void>;
  /** Streams must yield bytes from the beginning, including on resume, and declare their total size. */
  upload(input: FolderInput & {
    data: string | Uint8Array | AsyncIterable<Uint8Array>;
    size?: number;
    uploadId?: string;
    onProgress?: (progress: {uploadId: string; offset: number; size: number}) => void;
  }): Promise<DriveEntry>;
  /** Drain the iterator to verify the complete file digest. Memory is bounded to one chunk. */
  read(id: string, options?: Options): AsyncIterableIterator<Uint8Array>;
}
