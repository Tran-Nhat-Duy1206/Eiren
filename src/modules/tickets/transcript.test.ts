import { describe, expect, it } from 'vitest';
import { transcriptChunks } from './transcript.js';

describe('private transcript retrieval', () => {
  it('splits oversized text on UTF-8 boundaries without losing messages', () => {
    const source = 'aé🧡\n'.repeat(20);
    const chunks = transcriptChunks(source, 8);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 8)).toBe(true);
    expect(chunks.map(chunk => chunk.toString('utf8')).join('')).toBe(source);
  });
  it('retains empty transcripts and rejects impossible chunk sizes', () => {
    expect(transcriptChunks('').map(chunk => chunk.length)).toEqual([0]);
    expect(() => transcriptChunks('text', 0)).toThrow();
  });
});
