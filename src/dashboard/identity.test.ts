import { describe, expect, it } from 'vitest';
import { brandMark, emptyArt } from './brand.js';
import { dashboardCss, renderLogin, renderGuildPicker, renderPage } from './ui.js';
import { statusBadge } from './presentation.js';

const css = dashboardCss();
const token = (name: string) => css.match(new RegExp(`--${name}:(#[0-9a-f]{6})[;}]`))![1]!;
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0]! + .05) / (values[1]! + .05);
}
describe('black-purple dashboard identity', () => {
  it('uses static safe decorative SVG without references or duplicate IDs', () => {
    for (const svg of [brandMark, emptyArt]) {
      expect(svg).toContain('aria-hidden="true" focusable="false"');
      expect(svg).not.toMatch(/script|foreignObject|\bon\w+\s*=|javascript:|\bhref\s*=|\bid\s*=|<image|<style/i);
      expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    }
  });
  it('places compact identity beside Eiren and only selective empty art', () => {
    const login = renderLogin();
    expect(login.split(brandMark)).toHaveLength(3);
    expect(login).toContain('login-identity');
    expect(login).not.toContain(emptyArt);
    expect(renderGuildPicker([])).toContain(emptyArt);
    expect(renderGuildPicker([{ id: '123', name: '<unsafe>' }])).not.toContain(emptyArt);
    expect(renderGuildPicker([{ id: '123', name: '<unsafe>' }])).toContain('&lt;unsafe&gt;');
    expect(renderPage({ page: 'tickets', guildId: '123', guildName: 'Test', csrfToken: 'csrf' })).not.toContain(emptyArt);
  });
  it('centralizes near-black foundations and restrained URL-free gradients', () => {
    expect(token('bg')).toBe('#08080d');
    expect(token('surface')).toBe('#11101a');
    expect(token('surface-raised')).toBe('#191526');
    expect(token('surface-muted')).toBe('#0d0c13');
    for (const name of ['gradient-brand', 'gradient-brand-subtle', 'gradient-surface', 'glow-purple', 'glow-purple-strong']) expect(css).toContain(`--${name}:`);
    expect(css).toContain('radial-gradient');
    expect(css).not.toMatch(/url\(|backdrop-filter|\bfilter:|animation:/);
  });
  it('meets practical text and focus contrast including every primary gradient stop', () => {
    for (const [foreground, background] of [['text', 'bg'], ['text-muted', 'surface'], ['danger', 'danger-surface'], ['success', 'success-surface'], ['warning', 'warning-surface'], ['info', 'info-surface'], ['neutral', 'neutral-surface']]) expect(contrast(token(foreground!), token(background!))).toBeGreaterThanOrEqual(4.5);
    const gradient = css.match(/--gradient-brand:([^;]+);/)![1]!;
    const stops = gradient.match(/#[0-9a-f]{6}/g)!;
    expect(stops.length).toBe(3);
    for (const stop of stops) expect(contrast('#ffffff', stop)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('focus'), token('bg'))).toBeGreaterThanOrEqual(3);
    expect(css).toContain('outline:3px solid var(--focus)');
  });
  it('retains semantic separation and red destructive controls', () => {
    expect(statusBadge('UNCERTAIN')).toContain('status-warning');
    expect(css).toContain('.status[data-status="UNCERTAIN"]{border-style:dashed}');
    expect(statusBadge('PENDING')).toContain('status-warning');
    expect(statusBadge('FAILED')).toContain('status-danger');
    expect(statusBadge('DISABLED')).toContain('status-neutral');
    expect(css).toContain('.btn-danger{background:var(--danger-surface);color:var(--danger);border-color:var(--danger)}');
    expect(css).toContain('.btn-danger:not(:disabled):hover{background:var(--danger-surface);border-color:var(--danger)}');
    const red = token('danger');
    expect(parseInt(red.slice(1, 3), 16)).toBeGreaterThan(parseInt(red.slice(3, 5), 16));
    expect(token('focus')).not.toBe(token('warning'));
  });
  it('uses bounded interaction motion, no disabled glow and reduced-motion overrides', () => {
    expect(css).toContain('160ms ease');
    expect(css).toContain('@media(prefers-reduced-motion:reduce)');
    expect(css).toContain('transition:none!important;transform:none!important');
    expect(css).toContain('button:disabled:hover');
    expect(css).toContain('@media(max-width:48rem)');
    expect(css).toContain('min-height:44px');
    expect(css).toContain('min-width:7rem');
    expect(css).toContain('.status-known{white-space:nowrap;max-width:none}');
    expect(css).not.toMatch(/\.panel:hover/);
  });
});
