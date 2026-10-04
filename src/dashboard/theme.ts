export const dashboardTheme = `:root{color-scheme:dark;--bg:#08080d;--surface:#11101a;--surface-raised:#191526;--surface-muted:#0d0c13;--text:#f4f1fa;--text-muted:#bcb3ce;--border:#3b334b;--border-strong:#756487;--accent:#a78bfa;--focus:#c4b5fd;--success:#a1d4af;--warning:#eac478;--danger:#f0a9af;--info:#c4b5fd;--neutral:#c8bfd5;--success-surface:#203b2c;--warning-surface:#3c3221;--danger-surface:#3b252c;--info-surface:#25183c;--neutral-surface:#24202e;--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.25rem;--space-6:1.5rem;--space-8:2rem;--type-meta:.8125rem;--type-small:.875rem;--type-body:1rem;--type-subheading:1.125rem;--type-section:1.25rem;--type-title:1.75rem;--muted:var(--text-muted);--line:var(--border);--gradient-brand:linear-gradient(120deg,#5b21b6 0%,#6d28d9 52%,#7030c0 100%);--gradient-brand-subtle:linear-gradient(110deg,#5b21b626,#8b5cf610);--gradient-surface:linear-gradient(135deg,#191526,#11101a 70%);--glow-purple:0 4px 16px #7c3aed1a;--glow-purple-strong:0 6px 20px #7c3aed33}
*{box-sizing:border-box}
html{overflow-wrap:anywhere}
body{margin:0;background:radial-gradient(ellipse at 85% 0%,#7c3aed0d,transparent 45%),radial-gradient(ellipse at 10% 0%,#5b21b60a,transparent 40%),var(--bg);color:var(--text);font:var(--type-body)/1.55 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;grid-template-columns:minmax(13rem,15rem) minmax(0,1fr)}
body.public-page{grid-template-columns:minmax(0,1fr)}
a{color:var(--accent);text-underline-offset:.18em}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,.table-wrap:focus-visible,.nav-groups:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.skip{position:absolute;left:-9999px;top:0;background:var(--surface);padding:var(--space-3);z-index:20}
.skip:focus{left:var(--space-4)}
.top{grid-column:1/-1;display:flex;gap:var(--space-5);align-items:center;flex-wrap:wrap;padding:var(--space-4) var(--space-6);border-bottom:1px solid var(--border);background:var(--surface-muted);min-width:0}
.brand{font-weight:750;font-size:var(--type-section);color:var(--text);text-decoration:none;min-height:44px;display:flex;align-items:center}
.header-context{display:grid;gap:var(--space-1);min-width:0;flex:1}
.logout{margin:0;padding:0;background:none;border:0;max-width:none;display:block;width:auto;flex:0 0 auto}
.side{min-width:0;padding:var(--space-5) var(--space-3);border-right:1px solid var(--border);background:var(--surface-muted)}
.side ul{list-style:none;margin:var(--space-1) 0 0;padding:0}
.side a{display:flex;align-items:center;min-height:44px;padding:var(--space-2) var(--space-3);text-decoration:none;border-left:3px solid transparent;color:var(--text-muted)}
.side a:hover{background:var(--surface)}
.side a[aria-current=page]{background:var(--gradient-brand-subtle);border-left-color:var(--accent);color:var(--text);font-weight:700}
.server-picker{font-weight:650}
.nav-group{margin-top:var(--space-5)}
.nav-group h2{font-size:var(--type-meta);color:var(--text-muted);margin:0 var(--space-3);font-weight:650}
.nav-hint{display:none}
main{min-width:0;padding:var(--space-8);width:100%}
.content{max-width:76rem;margin-inline:auto;min-width:0}
.public-page main{display:grid;align-content:start;padding-top:clamp(2rem,8vh,5rem)}
.auth-panel{width:100%;max-width:42rem;margin-inline:auto}
.page-header{margin-bottom:var(--space-6)}
h1,h2,h3,h4{line-height:1.3;font-weight:650}
h1{font-size:var(--type-title);margin:0 0 var(--space-2)}
h2{font-size:var(--type-section);margin:var(--space-6) 0 var(--space-3)}
h3,h4{font-size:var(--type-subheading);margin:var(--space-5) 0 var(--space-2)}
p{margin:0 0 var(--space-3)}
.panel{background:var(--surface);border:1px solid var(--border);padding:var(--space-6);border-radius:.35rem;margin-bottom:var(--space-6)}
.panel>h2:first-child{margin-top:0}
.muted,.eyebrow,.field-help,caption{color:var(--text-muted)}
small,.field-help{font-size:var(--type-small)}
.field-help{display:block;line-height:1.5}
.notice,.error,.disabled,.empty-state,.empty{padding:var(--space-4);border:1px solid var(--border);border-radius:.25rem;margin-bottom:var(--space-4)}
.notice p:last-child,.empty-state p:last-child{margin-bottom:0}
.notice strong{display:block;margin-bottom:var(--space-1)}
.notice-success{background:var(--success-surface);border-color:var(--success)}
.notice-warning{background:var(--warning-surface);border-color:var(--warning)}
.notice-danger,.error{background:var(--danger-surface);border-color:var(--danger)}
.notice-info{background:var(--info-surface);border-color:var(--info)}
.notice-neutral,.disabled{background:var(--neutral-surface);border-color:var(--border-strong)}
.empty-state,.empty{background:var(--surface-muted)}
.status{display:inline-flex;align-items:center;font-size:var(--type-meta);font-weight:650;padding:var(--space-1) var(--space-2);border:1px solid currentColor;border-radius:.2rem;line-height:1.4;max-width:100%;overflow-wrap:anywhere}
.status-known{white-space:nowrap;max-width:none}
.status-success{color:var(--success);background:var(--success-surface)}
.status-warning{color:var(--warning);background:var(--warning-surface)}
.status-danger{color:var(--danger);background:var(--danger-surface)}
.status-info{color:var(--info);background:var(--info-surface)}
.status-neutral{color:var(--neutral);background:var(--neutral-surface)}
.table-wrap{overflow-x:auto;max-width:100%;min-width:0;border:1px solid var(--border);border-radius:.25rem;margin-bottom:var(--space-4)}
table{background:var(--surface-muted);border-collapse:collapse;width:100%;text-align:left;font-size:var(--type-small)}
caption{text-align:left;padding:var(--space-3);font-size:var(--type-meta);background:var(--surface-muted)}
th,td{min-width:7rem;border-bottom:1px solid var(--border);padding:var(--space-3);overflow-wrap:anywhere;vertical-align:top}
th{font-weight:650;background:var(--surface)}
td a{display:inline-flex;align-items:center;min-height:44px}
tr:last-child td{border-bottom:0}
.id-value,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:var(--type-meta);color:var(--text-muted);overflow-wrap:anywhere}
dl.metadata,dl:not(.metric-grid){display:grid;grid-template-columns:minmax(8rem,15rem) minmax(0,1fr);gap:var(--space-2) var(--space-4)}
dd{margin:0;overflow-wrap:anywhere}
.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3);margin:0 0 var(--space-6)}
.metric{padding:var(--space-4);background:var(--surface);border:1px solid var(--border);border-radius:.25rem}
.metric dt{color:var(--text-muted);font-size:var(--type-small)}
.metric dd{font-size:var(--type-title);font-weight:650;line-height:1.3;margin-top:var(--space-2)}
form{display:grid;gap:var(--space-4);max-width:38rem;width:100%;padding:var(--space-5);background:var(--surface);border:1px solid var(--border);border-radius:.3rem;margin:var(--space-4) 0 var(--space-6);min-width:0}
form>h2,form>h3{margin:0}
.form-group,label{display:grid;gap:var(--space-2);min-width:0}
.check{display:flex;gap:var(--space-3);align-items:flex-start;min-height:44px}
.check input{width:1.2rem;min-width:1.2rem;height:1.2rem;margin-top:var(--space-1)}
input,select,textarea{background:var(--bg);color:var(--text);border:1px solid var(--border-strong);border-radius:.2rem;padding:var(--space-3);width:100%;min-width:0;font:inherit;min-height:44px}
input[type=checkbox]{width:1.2rem;min-width:1.2rem;height:1.2rem;min-height:1.2rem;accent-color:var(--accent)}
label:has(>input[type=checkbox]){display:flex;align-items:flex-start;gap:var(--space-3);min-height:44px}
label:has(>input[type=checkbox])>input{order:-1;margin-top:var(--space-1)}
textarea{resize:vertical}
button,.button{font:inherit;font-weight:600;display:inline-flex;justify-content:center;align-items:center;min-height:44px;padding:var(--space-2) var(--space-4);border:1px solid var(--border-strong);border-radius:.25rem;background:var(--surface-raised);color:var(--text);text-decoration:none;cursor:pointer;max-width:100%;white-space:normal;overflow-wrap:anywhere}
button:hover,.button:hover{border-color:var(--text-muted)}
.btn-primary{background:var(--gradient-brand);color:#ffffff;border-color:#8b5cf6;box-shadow:var(--glow-purple)}
.btn-secondary{background:var(--surface-raised)}
.btn-danger{background:var(--danger-surface);color:var(--danger);border-color:var(--danger)}
.btn-danger:not(:disabled):hover{background:var(--danger-surface);border-color:var(--danger)}
.btn-subtle{background:transparent;color:var(--text-muted)}
button:disabled{cursor:not-allowed;opacity:.7}
.action-group{display:flex;gap:var(--space-2);flex-wrap:wrap}
.inline,.filter-form{display:flex;align-items:end;gap:var(--space-3);flex-wrap:wrap}
.filter-form label{flex:1;min-width:10rem}
.filter-form .form-group{flex:1}
fieldset{min-width:0;border:1px solid var(--border);padding:var(--space-4);margin:0;display:grid;gap:var(--space-4)}
legend{padding-inline:var(--space-2)}
.guild-list{list-style:none;margin:0;padding:0}
.guild-list li{margin-bottom:var(--space-2)}
.guild-list a{display:flex;gap:var(--space-3);justify-content:space-between;flex-wrap:wrap;min-height:44px;padding:var(--space-3) var(--space-4);border:1px solid var(--border);border-radius:.35rem;background:var(--gradient-surface);text-decoration:none}
.guild-list a strong{color:var(--text)}
.data-section{margin-block:var(--space-6)}
footer{grid-column:1/-1;border-top:1px solid var(--border);padding:var(--space-4) var(--space-6);font-size:var(--type-meta);color:var(--text-muted)}
@media(max-width:64rem){body{grid-template-columns:12rem minmax(0,1fr)}
main{padding:var(--space-6)}
.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:48rem){body{grid-template-columns:minmax(0,1fr)}
.side{border-right:0;border-bottom:1px solid var(--border);padding:var(--space-3)}
.nav-hint{display:block;font-size:var(--type-meta);margin:var(--space-2) var(--space-3)}
.nav-groups{display:flex;gap:var(--space-3);overflow-x:auto;padding-bottom:var(--space-2);scrollbar-width:auto}
.nav-group{flex:0 0 11rem;margin-top:var(--space-2)}
main{padding:var(--space-4)}
.top{padding:var(--space-3) var(--space-4)}
.panel{padding:var(--space-4)}
.action-group{flex-wrap:wrap}
form{max-width:100%;padding:var(--space-4)}
.table-wrap{width:100%;overflow-x:auto}
table{min-width:34rem}
.filter-form{align-items:stretch}
.filter-form .form-group{min-width:100%}
dl.metadata,dl:not(.metric-grid){grid-template-columns:minmax(0,1fr)}
dd{margin-bottom:var(--space-2)}
}
@media(max-width:27rem){.metric-grid{grid-template-columns:minmax(0,1fr)}
h1{font-size:1.5rem}
.header-context{flex-basis:calc(100% - 7rem)}
.logout{margin-left:auto}
form button,.action-group button{width:100%}
.check{align-items:flex-start}
}
.status[data-status="UNCERTAIN"]{border-style:dashed}
/* Identity stays decorative; quiet panels never move on hover. */
.brand{gap:var(--space-2)}
.brand-mark{display:block;width:2rem;height:2rem;flex:0 0 auto}
.top{background:linear-gradient(100deg,#5b21b612,transparent 55%),var(--surface-muted)}
.login-panel{background:radial-gradient(ellipse at 95% 0%,#7c3aed14,transparent 65%),var(--surface);border-top:2px solid #6d28d9;box-shadow:var(--glow-purple)}
.login-identity{display:flex;align-items:center;gap:var(--space-3);font-size:1.5rem;font-weight:750;margin-bottom:var(--space-6)}
.login-identity .brand-mark{width:3.5rem;height:3.5rem}
.auth-panel>.page-header{border-bottom:1px solid var(--border);padding-bottom:var(--space-4)}
.page-header h1{border-left:3px solid var(--accent);padding-left:var(--space-3)}
.metric{border-top:2px solid #695087}
.metric dd{color:#ddd0fa}
.empty-art{display:block;width:7rem;height:4rem;margin:var(--space-3) auto}
button,.button,.side a,.guild-list a{transition:transform 160ms ease,border-color 160ms ease,box-shadow 160ms ease,background-color 160ms ease}
.btn-primary:not(:disabled):not([aria-disabled=true]):hover{transform:translateY(-1px);box-shadow:var(--glow-purple-strong);border-color:var(--focus)}
.guild-list a:hover{border-color:var(--accent);box-shadow:var(--glow-purple);transform:translateY(-1px)}
button:disabled,.button[aria-disabled=true]{box-shadow:none;transform:none;cursor:not-allowed}
button:disabled:hover,.button[aria-disabled=true]:hover{border-color:var(--border-strong);box-shadow:none;transform:none}
@media(max-width:48rem){body{background:radial-gradient(ellipse at 90% 0%,#7c3aed07,transparent 35%),var(--bg)}
.brand-mark{width:1.75rem;height:1.75rem}
.login-identity .brand-mark{width:2.75rem;height:2.75rem}
.login-panel{box-shadow:none}
}
@media(prefers-reduced-motion:reduce){button,.button,.side a,.guild-list a{transition:none!important;transform:none!important}}
`;
