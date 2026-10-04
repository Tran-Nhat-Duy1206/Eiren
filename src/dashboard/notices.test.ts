import { describe,it,expect } from 'vitest';
import { noticeForPage,noticeKeyForAction } from './notices.js';
import { renderPage } from './ui.js';
describe('V8.5 fixed SSR PRG notice contract',()=>{
  it('allows only fixed keys for their own ordinary pages and ignores all unknown values',()=>{
    expect(noticeForPage('settings','module-updated')).toBe('Module availability updated. Historical data is not deleted.');
    for(const key of ['<script>alert(1)</script>','__proto__','constructor',['module-updated'],new Error('PRIVATE'),undefined]) expect(noticeForPage('settings',key)).toBeUndefined();
    expect(noticeForPage('privacy','module-updated')).toBeUndefined(); expect(noticeKeyForAction('privacy-execute')).toBeUndefined(); expect(noticeKeyForAction('retention-confirm')).toBeUndefined(); expect(noticeKeyForAction('automation-update')).toBeUndefined(); expect(noticeKeyForAction('__proto__')).toBeUndefined();
  });
  it('uses escaped fixed text, status feedback and no user-value/session/JavaScript channel',()=>{
    const html=renderPage({page:'settings',guildId:'900000000000000001',guildName:'Synthetic',csrfToken:'synthetic-csrf',actorLevel:'ADMIN',data:[],notice:noticeForPage('settings','timezone-updated')}); expect(html).toContain('Server timezone updated.');expect(html).toContain('role="status"'); expect(html).not.toContain('<script'); expect(html).not.toContain('onchange=');
    expect(noticeKeyForAction('guild-timezone')).toBe('timezone-updated'); expect(noticeKeyForAction('giveaway-end')).toBe('giveaway-ended');
  });
});
