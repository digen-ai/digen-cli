export interface ConversationBusyDetail {
  code: "CONVERSATION_BUSY";
  message: string;
  existing_task_ids?: string[];
  limit?: number;
}

export interface SessionQuotaExceededDetail {
  code: "SESSION_QUOTA_EXCEEDED";
  message: string;
  limit?: number;
  current?: number;
  user_type?: string;
}

export type StructuredErrorDetail = ConversationBusyDetail | SessionQuotaExceededDetail;

export class ApiError extends Error {
  statusCode: number;
  detail: string;
  errCode?: string | number;
  structured?: StructuredErrorDetail;

  constructor(
    statusCode: number,
    detail: string,
    opts?: { errCode?: string | number; structured?: StructuredErrorDetail },
  ) {
    super(`HTTP ${statusCode}: ${detail}`);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.detail = detail;
    this.errCode = opts?.errCode;
    this.structured = opts?.structured;
  }
}
