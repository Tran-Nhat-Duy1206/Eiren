import type { APIEmbed } from 'discord.js';

export type PresentationKind = 'SUCCESS' | 'INFO' | 'WARNING' | 'ERROR' | 'UNCERTAIN' | 'DISABLED';
const colors: Record<PresentationKind, number> = {
  SUCCESS: 0x398568, INFO: 0x8b5cf6, WARNING: 0xb58a42,
  ERROR: 0xb85b5b, UNCERTAIN: 0xb58a42, DISABLED: 0x737b86,
};
export function presentationColor(kind: PresentationKind): number { return colors[kind]; }

/** Generated status/configuration output only. Never replace an intentional announcement ping. */
export const safeMentions = { parse: [] as [] };
export const uncertainText = 'The external side effect cannot be proven. Do not blindly retry; inspect and reconcile.';
export const redactedText = 'Content redacted by retention policy.';

/** Explicit text only: deliberately accepts neither unknown nor Error objects. */
export function boundedContent(text: string): string { return bound(text, 2000); }
function explicitText(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('Presentation text must be an explicit string.');
}
function embedRecord(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TypeError('Presentation embed must contain only supported payload properties.');
  }
}
function bound(text: string, maximum: number): string {
  explicitText(text);
  if (text.length <= maximum) return text;
  if (maximum <= 0) return '';
  // Do not leave a dangling UTF-16 high surrogate at the truncation boundary.
  let end = maximum - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return `${text.slice(0, end)}…`;
}

/** Source epoch, not guild display timezone. */
export function discordTimestamp(source: Date | number, style: 'F' | 'R' = 'F'): string {
  const epoch = source instanceof Date ? source.getTime() : source;
  if (!Number.isFinite(epoch)) throw new RangeError('Timestamp must be finite.');
  return `<t:${Math.floor(epoch / 1000)}:${style}>`;
}

/** For generated summaries, not user narratives: enforce individual and aggregate Discord limits. */
export function boundedEmbed(input: APIEmbed): APIEmbed {
  embedRecord(input, ['title', 'type', 'description', 'url', 'timestamp', 'color', 'footer', 'image', 'thumbnail', 'video', 'provider', 'author', 'fields']);
  for (const key of ['title', 'type', 'description', 'url', 'timestamp'] as const) {
    if (input[key] !== undefined) explicitText(input[key]);
  }
  if (input.color !== undefined && (typeof input.color !== 'number' || !Number.isFinite(input.color))) {
    throw new TypeError('Presentation embed color must be a finite number.');
  }
  const nested = [
    [input.author, ['name', 'url', 'icon_url', 'proxy_icon_url']],
    [input.footer, ['text', 'icon_url', 'proxy_icon_url']],
    [input.image, ['url', 'proxy_url', 'height', 'width']],
    [input.thumbnail, ['url', 'proxy_url', 'height', 'width']],
    [input.video, ['url', 'proxy_url', 'height', 'width']],
    [input.provider, ['name', 'url']],
  ] as const;
  for (const [value, keys] of nested) {
    if (value === undefined) continue;
    embedRecord(value, keys);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      if (key === 'height' || key === 'width') {
        if (typeof item !== 'number' || !Number.isFinite(item)) throw new TypeError('Presentation embed dimensions must be finite numbers.');
      } else explicitText(item);
    }
  }
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) throw new TypeError('Presentation embed fields must be an array.');
    for (const field of input.fields) {
      embedRecord(field, ['name', 'value', 'inline']);
      explicitText(field.name); explicitText(field.value);
      if (field.inline !== undefined && typeof field.inline !== 'boolean') throw new TypeError('Presentation field inline must be a boolean.');
    }
  }
  let remaining = 6000;
  const take = (text: string, limit: number): string => {
    const result = bound(text, Math.min(limit, remaining));
    remaining -= result.length;
    return result;
  };
  const output: APIEmbed = { ...input };
  if (input.title !== undefined) output.title = take(input.title, 256);
  if (input.description !== undefined) output.description = take(input.description, 4096);
  if (input.author) output.author = { ...input.author, name: take(input.author.name, 256) };
  if (input.footer) output.footer = { ...input.footer, text: take(input.footer.text, 2048) };
  if (input.fields) {
    output.fields = [];
    for (const field of input.fields.slice(0, 25)) {
      if (remaining < 2) break;
      const name = take(field.name || '\u200b', Math.min(256, remaining - 1));
      const value = take(field.value || '\u200b', 1024);
      output.fields.push({ ...field, name, value });
    }
  }
  return output;
}

/** Meaning is present in the title, independent of color. Short confirmations should stay text. */
export function statusEmbed(kind: PresentationKind, title: string, description: string): APIEmbed {
  explicitText(title); explicitText(description);
  const labels: Record<PresentationKind, string> = {
    SUCCESS: 'Success', INFO: 'Information', WARNING: 'Warning', ERROR: 'Error',
    UNCERTAIN: 'Uncertain', DISABLED: 'Disabled',
  };
  return boundedEmbed({ color: presentationColor(kind), title: `${labels[kind]} · ${title}`,
    description: kind === 'UNCERTAIN' ? `${uncertainText}\n${description}` : description });
}
