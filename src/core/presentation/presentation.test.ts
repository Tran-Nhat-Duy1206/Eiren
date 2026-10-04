import { describe, expect, it } from 'vitest';
import { EmbedBuilder } from 'discord.js';
import { boundedContent, boundedEmbed, discordTimestamp, presentationColor, redactedText, safeMentions, statusEmbed, uncertainText } from './index.js';

/** Synthetic review DTOs only; not Discord-client screenshots or private guild data. */
export const discordReviewGallery = [
  { scenario: 'success', visibility: 'ephemeral', payload: { content: 'Setup complete. Language: en; timezone: UTC. Use /config to manage settings.', allowedMentions: safeMentions } },
  { scenario: 'validation', visibility: 'ephemeral', payload: { embeds: [statusEmbed('ERROR', 'Validation', 'Use this command in a server.')], allowedMentions: safeMentions } },
  { scenario: 'moderation staff case', visibility: 'ephemeral', payload: { content: 'Case #42 — WARN (SUCCEEDED)\nTarget: 100000000000000001\nModerator: 100000000000000002\nReason: Synthetic staff-authorized reason.\nCreated: <t:1767225600:F>', allowedMentions: safeMentions } },
  { scenario: 'verification', visibility: 'public', payload: { embeds: [statusEmbed('INFO', 'Verification', 'Read the server rules before verifying.')], components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Verify', custom_id: 'eiren:v2:verify' }] }], allowedMentions: safeMentions } },
  { scenario: 'role menu', visibility: 'public', payload: { content: '**Community roles**\nChoose at most one role.', components: [{ type: 1, components: [{ type: 3, custom_id: 'role-menu:select:7', options: [{ label: 'Reader', value: '12' }], min_values: 0, max_values: 1 }] }], allowedMentions: safeMentions } },
  { scenario: 'suggestion', visibility: 'public', payload: { embeds: [boundedEmbed({ title: 'Suggestion #3', description: 'Synthetic original suggestion narrative.', color: presentationColor('INFO') })], components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Upvote', custom_id: 'suggest:up:3' }, { type: 2, style: 2, label: 'Downvote', custom_id: 'suggest:down:3' }] }], allowedMentions: safeMentions } },
  { scenario: 'event', visibility: 'public', payload: { embeds: [boundedEmbed({ title: 'Synthetic community event', description: 'Synthetic original event description.', color: presentationColor('INFO'), fields: [{ name: 'Event', value: '#2 · SCHEDULED' }, { name: 'Starts', value: '<t:1767225600:F>' }] })], components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Join', custom_id: 'event:join:2' }, { type: 2, style: 2, label: 'Leave', custom_id: 'event:leave:2' }] }], allowedMentions: safeMentions } },
  { scenario: 'giveaway result', visibility: 'public', payload: { content: 'Giveaway #19 draw #2 results — Synthetic original prize\n<@100000000000000003>', allowedMentions: safeMentions } },
  { scenario: 'Automation Uncertain', visibility: 'review-only', payload: { embeds: [statusEmbed('UNCERTAIN', 'Automation delivery', 'Execution ID: synthetic-run-42')], allowedMentions: safeMentions } },
  { scenario: 'disabled', visibility: 'ephemeral', payload: { embeds: [statusEmbed('DISABLED', 'Community profile', 'Levels and reputation are disabled in this server.')], allowedMentions: safeMentions } },
];

describe('Discord presentation contract', () => {
  it('provides ten safe representative review payloads without SDK or client claims', () => {
    expect(discordReviewGallery).toHaveLength(10);
    for (const item of discordReviewGallery) {
      expect(item.payload.allowedMentions.parse).toEqual([]);
      if ('content' in item.payload) expect(item.payload.content!.length).toBeLessThanOrEqual(2000);
      if ('embeds' in item.payload) for (const embed of item.payload.embeds!) expect(() => new EmbedBuilder(embed).toJSON()).not.toThrow();
    }
    expect(JSON.stringify(discordReviewGallery)).toContain(uncertainText);
    expect(discordReviewGallery.find(item => item.scenario === 'giveaway result')!.payload.allowedMentions).toEqual({ parse: [] });
  });
  it('rejects runtime nontext without coercing or exposing raw errors', () => {
    const raw = new Error('PRIVATE provider token');
    const coercion = { toString: () => { throw new Error('COERCED secret'); } };
    for (const value of [raw, coercion, null, 42, undefined]) {
      expect(() => boundedContent(value as never)).toThrow('Presentation text must be an explicit string.');
      expect(() => statusEmbed('INFO', value as never, 'safe')).toThrow('Presentation text must be an explicit string.');
      expect(() => statusEmbed('UNCERTAIN', 'safe', value as never)).toThrow('Presentation text must be an explicit string.');
    }
  });
  it('rejects errors, malformed roots and unexpected serialized properties', () => {
    for (const value of [new Error('PRIVATE'), null, [], 'text', { title: 'safe', stack: 'PRIVATE' },
      { title: new Error('PRIVATE') }, { author: new Error('PRIVATE') },
      { fields: [{ name: 'safe', value: new Error('PRIVATE') }] },
      { footer: { text: 'safe', stack: 'PRIVATE' } }]) {
      try { boundedEmbed(value as never); throw new Error('Unexpected acceptance'); }
      catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).not.toMatch(/PRIVATE|stack/);
      }
    }
    const valid = { title: 'Original narrative', color: 123, url: 'https://example.com',
      image: { url: 'https://example.com/image.png' }, author: { name: 'Author' },
      footer: { text: redactedText }, fields: [{ name: 'ID', value: '42', inline: true }] };
    expect(boundedEmbed(valid)).toEqual(valid);
  });
  it('keeps all semantic kinds explicit and disabled distinct from error', () => {
    for (const kind of ['SUCCESS', 'INFO', 'WARNING', 'ERROR', 'UNCERTAIN', 'DISABLED'] as const) {
      expect(statusEmbed(kind, 'Status', 'Details').title).toBeTruthy();
      expect(presentationColor(kind)).toBeGreaterThan(0);
    }
    expect(presentationColor('DISABLED')).not.toBe(presentationColor('ERROR'));
    expect(statusEmbed('UNCERTAIN', 'Delivery', 'Run ID: 42').description).toContain(uncertainText);
    expect(uncertainText).toContain('cannot be proven');
    expect(uncertainText).toContain('Do not blindly retry; inspect and reconcile');
  });
  it('floors original epoch without timezone shifts, including relative dates', () => {
    expect(discordTimestamp(new Date(1999))).toBe('<t:1:F>');
    expect(discordTimestamp(1999, 'R')).toBe('<t:1:R>');
    expect(discordTimestamp(-1)).toBe('<t:-1:F>');
    expect(() => discordTimestamp(NaN)).toThrow(RangeError);
  });
  it('bounds generated output and aggregate embeds accepted by Discord builders', () => {
    expect(boundedContent('x'.repeat(2001))).toHaveLength(2000);
    const embed = boundedEmbed({ title: 'T'.repeat(300), description: 'D'.repeat(5000),
      author: { name: 'A'.repeat(300) }, footer: { text: 'F'.repeat(3000) },
      fields: Array.from({ length: 30 }, () => ({ name: 'N'.repeat(300), value: 'V'.repeat(2000) })) });
    expect(embed.title!.length).toBeLessThanOrEqual(256);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.footer!.text.length).toBeLessThanOrEqual(2048);
    expect(embed.fields!.length).toBeLessThanOrEqual(25);
    const total = [embed.title, embed.description, embed.author?.name, embed.footer?.text,
      ...embed.fields!.flatMap(field => [field.name, field.value])].reduce<number>((n, text) => n + (text?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(() => new EmbedBuilder(embed).toJSON()).not.toThrow();
    const fields = boundedEmbed({ fields: Array.from({ length: 30 }, () => ({ name: 'n', value: 'v' })) });
    expect(fields.fields).toHaveLength(25);
    expect(boundedEmbed({ fields: [{ name: 'N'.repeat(300), value: 'V'.repeat(2000) }] }).fields![0]).toEqual({ name: 'N'.repeat(255) + '…', value: 'V'.repeat(1023) + '…' });
  });
  it('does not ping generated statuses or invent visibility, and retains redaction', () => {
    expect(safeMentions).toEqual({ parse: [] });
    expect(statusEmbed('INFO', 'Settings', '@everyone <@123>')).not.toHaveProperty('flags');
    expect(boundedContent(redactedText)).toBe('Content redacted by retention policy.');
    expect(boundedContent('Original user narrative')).toBe('Original user narrative');
  });
  it('retains builder edit/adopt shape and operational metadata in representative summaries', () => {
    const original = { title: 'Event', description: 'Starts <t:1:F>', fields: [{ name: 'Event ID', value: '42' }], color: presentationColor('INFO') };
    expect(new EmbedBuilder(boundedEmbed(original)).toJSON()).toEqual(original);
    expect(statusEmbed('SUCCESS', 'Profile updated', 'User ID: 42').description).toBe('User ID: 42');
    expect(statusEmbed('DISABLED', 'Automation', 'No execution scheduled.').title).toContain('Disabled');
  });
});
