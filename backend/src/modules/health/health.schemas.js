export const healthResponseSchema = {
  type: 'object',
  required: ['status', 'service', 'version', 'time', 'uptimeSeconds', 'database'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    service: { type: 'string' },
    version: { type: 'string' },
    time: { type: 'string', format: 'date-time' },
    uptimeSeconds: { type: 'integer' },
    database: {
      type: 'object',
      required: ['status', 'latencyMs'],
      properties: {
        status: { type: 'string', enum: ['up', 'down'] },
        latencyMs: { type: 'integer' },
        error: { type: 'string' },
      },
    },
  },
};

