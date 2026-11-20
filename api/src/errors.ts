export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_CLOSED'
  | 'APP_DISABLED'
  | 'RATE_LIMITED'
  | 'CAP_REACHED'
  | 'INVALID_PAYLOAD'
  | 'SCHEMA_FAILED'
  | 'TOKEN_INVALID'
  | 'CLIENT_DELETED'
  | 'UNAUTHORISED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const defaultStatus: Record<ErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_CLOSED: 409,
  APP_DISABLED: 403,
  RATE_LIMITED: 429,
  CAP_REACHED: 429,
  INVALID_PAYLOAD: 400,
  SCHEMA_FAILED: 422,
  TOKEN_INVALID: 401,
  CLIENT_DELETED: 410,
  UNAUTHORISED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    opts: { status?: number; retryAfter?: number } = {},
  ) {
    super(message);
    this.statusCode = opts.status ?? defaultStatus[code];
    this.retryAfter = opts.retryAfter;
  }
  readonly retryAfter?: number;

  toBody() {
    const error: { code: ErrorCode; message: string; retryAfter?: number } = { code: this.code, message: this.message };
    if (this.retryAfter !== undefined) error.retryAfter = this.retryAfter;
    return { error };
  }
}

export const roomNotFound = () => new ApiError('ROOM_NOT_FOUND', 'Room not found');
