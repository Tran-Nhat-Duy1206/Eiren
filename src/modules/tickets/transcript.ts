// Discord's minimum supported upload limit exceeds 7 MiB. Split on UTF-8 boundaries
// so even long transcripts remain retrievable without corrupting their text.
export function transcriptChunks(text: string, maxBytes = 7 * 1024 * 1024): Buffer[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('Invalid transcript chunk size');
  const bytes = Buffer.from(text, 'utf8');
  if (!bytes.length) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) while (end > start && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end <= start) throw new Error('Unable to split UTF-8 transcript');
    chunks.push(Buffer.from(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}
