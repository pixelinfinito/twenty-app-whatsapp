export class ToolError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'ToolError';
  }
}

export const toolDenied = (code: string, detail?: string) => ({
  status: 'denied' as const, code, ...(detail ? { detail } : {}), warnings: [],
});
