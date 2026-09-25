import pino from 'pino';

function sanitize(value: string): string {
  const secrets = [process.env.DISCORD_TOKEN, process.env.DATABASE_URL];
  if (process.env.DATABASE_URL) {
    try {
      const password = new URL(process.env.DATABASE_URL).password;
      secrets.push(password, decodeURIComponent(password));
    } catch { /* env validation handles malformed URLs */ }
  }
  const configured = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  // Replacing a one-character password would destroy the entire stack. With short
  // credentials, suppress free-form error text rather than risk leaking them.
  if (configured.some(secret => secret.length <= 3)) return '[REDACTED: short credential configured]';
  return configured.sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
}

export function createLogger(level: string = 'info', destination?: pino.DestinationStream) {
  return pino({
    level,
    serializers: {
      err(error: Error) {
        const detail = pino.stdSerializers.err(error);
        return { type: detail.type, message: sanitize(detail.message), stack: sanitize(detail.stack ?? '') };
      },
    },
    base: { service: 'eiren-bot' },
    redact: {
      paths: [
        'token', '*.token', 'password', '*.password', 'secret', '*.secret',
        'authorization', '*.authorization', 'config.DISCORD_TOKEN',
        'config.DATABASE_URL', 'DATABASE_URL', 'DISCORD_TOKEN',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  }, destination);
}
export type Logger = ReturnType<typeof createLogger>;
