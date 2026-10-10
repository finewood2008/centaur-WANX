import { request, requestUpload } from "../request";

export type UploadExtractionStatus =
  | "ready"
  | "empty"
  | "unsupported"
  | "failed";

export interface UploadResponse {
  path: string;
  workspace_path: string;
  filename: string;
  media_type: string;
  url: string;
  access_url: string;
  /** Zhijun-only local text extraction; omitted by older WANX responses. */
  extraction_status?: UploadExtractionStatus | null;
  extraction_truncated?: boolean | null;
  extraction_characters?: number | null;
  extraction_error?: string | null;
}

export interface UploadedSourceResponse {
  ok: boolean;
  path: string;
  filename: string;
  media_type: string;
  /** Local extracted text. Always render as plain text. */
  content: string;
  status: UploadExtractionStatus;
  truncated: boolean;
  total_chars: number;
  stored_chars: number;
  has_more: boolean;
  offset: number;
  limit: number;
  error?: string | null;
}

/** Read a registered Zhijun upload's locally extracted text, never workspace bytes. */
export function getUploadedSource(
  agentId: string,
  path: string,
  options: { offset?: number; limit?: number } = {},
): Promise<UploadedSourceResponse> {
  const query = new URLSearchParams({
    path,
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 12000),
  });
  return request<UploadedSourceResponse>(
    `/agents/${agentId}/upload/source?${query}`,
  );
}

/**
 * Upload a chat attachment into the agent workspace ``inbound/`` directory.
 */
export async function uploadFile(
  agentId: string,
  file: File,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return requestUpload<UploadResponse>(`/agents/${agentId}/upload`, formData);
}

export const uploadImage = uploadFile;

export const uploadApi = { uploadFile, uploadImage, getUploadedSource };
