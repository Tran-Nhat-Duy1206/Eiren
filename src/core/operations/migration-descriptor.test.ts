import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATION_DESCRIPTOR as expected } from './migration-descriptor.js';

describe('release migration descriptor', () => {
  it('tracks the exact journal and only approved SQL newline variants', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    expect(journal.entries).toHaveLength(expected.count);
    expect(readdirSync('drizzle').filter((name) => name.endsWith('.sql'))).toHaveLength(expected.count);
    expect(journal.entries.at(-1)).toMatchObject({ idx: expected.count - 1, tag: expected.tag, when: expected.timestamp });
    const raw = readFileSync(`drizzle/${expected.tag}.sql`, 'utf8');
    const lf = raw.replaceAll('\r\n', '\n');
    const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
    expect(hash(lf)).toBe(expected.hash);
    expect(hash(lf.replaceAll('\n', '\r\n'))).toBe(expected.approvedCrlfHash);
    expect([expected.hash, expected.approvedCrlfHash]).toContain(hash(raw));
    for (const mutation of ['\n-- byte change\n', '\nUPDATE subject_requests SET version = version + 1;\n']) {
      expect(hash(lf + mutation)).not.toBe(expected.hash);
      expect(hash((lf + mutation).replaceAll('\n', '\r\n'))).not.toBe(expected.approvedCrlfHash);
    }
  });
});
