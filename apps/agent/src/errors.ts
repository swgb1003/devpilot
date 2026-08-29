import { randomUUID } from 'node:crypto';

import type { DevPilotErrorAction, DevPilotErrorCode, ErrorEnvelope } from '@devpilot/contracts';

export class AgentError extends Error {
  readonly code: DevPilotErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly action: DevPilotErrorAction;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(options: {
    code: DevPilotErrorCode;
    message: string;
    status: number;
    retryable?: boolean;
    action?: DevPilotErrorAction;
    details?: Readonly<Record<string, unknown>>;
  }) {
    super(options.message);
    this.name = 'AgentError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.action = options.action ?? 'NONE';
    if (options.details) {
      this.details = options.details;
    }
  }
}

export function toErrorResponse(
  error: unknown,
  traceId = randomUUID(),
): { readonly status: number; readonly body: ErrorEnvelope } {
  const normalized =
    error instanceof AgentError
      ? error
      : new AgentError({
          code: 'INTERNAL_ERROR',
          message: 'Agent処理中に予期しないエラーが発生しました。',
          status: 500,
          retryable: true,
          action: 'RETRY',
        });

  return {
    status: normalized.status,
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        action: normalized.action,
        traceId,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    },
  };
}
