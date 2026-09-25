import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

const previousToken = process.env.DISCORD_TOKEN;
const previousDatabase = process.env.DATABASE_URL;
afterEach(() => {
  if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = previousToken;
  if (previousDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabase;
});

describe('internal logger', () => {
  it('redacts credentials in fields and unexpected error stacks', () => {
    const token = 'private-test-token-12345';
    const password = 'private@test-password';
    process.env.DISCORD_TOKEN = token;
    process.env.DATABASE_URL = 'postgres://bot:private%40test-password@127.0.0.1:5432/eiren';
    let output = '';
    const destination = { write: (chunk: string) => { output += chunk; } };
    const logger = createLogger('info', destination);
    logger.error({ err: new Error(`${token} ${password}`), token, password,
      config: { DATABASE_URL: process.env.DATABASE_URL } }, 'Unexpected error');
    expect(output).toContain('Unexpected error');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(token);
    expect(output).not.toContain(password);
    expect(output).not.toContain('private%40test-password');
  });
  it('suppresses free-form error text for short database passwords', () => {
    process.env.DATABASE_URL = 'postgres://bot:pw@127.0.0.1:5432/eiren';
    let output = '';
    const logger = createLogger('info', { write: (chunk: string) => { output += chunk; } });
    logger.error({ err: new Error('driver reported password pw') }, 'Database failure');
    expect(output).toContain('[REDACTED: short credential configured]');
    expect(output).not.toContain('password pw');
  });
});
