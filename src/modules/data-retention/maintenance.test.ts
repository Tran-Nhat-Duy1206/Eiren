import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { supplementaryRedaction } from './maintenance.js';

describe('maintenance private fields', () => {
  it('clears report evidence and resolution plus appeal review with narrative', () => {
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(supplementaryRedaction('REPORT')).sql).toBe(',evidence_url = NULL,resolution_note = NULL');
    expect(dialect.sqlToQuery(supplementaryRedaction('APPEAL')).sql).toBe(',review_note = NULL');
    expect(dialect.sqlToQuery(supplementaryRedaction('TICKET')).sql).toBe('');
  });
});
