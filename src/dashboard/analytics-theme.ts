export const analyticsTheme = `
.analytics-page{min-width:0}
body:has(.analytics-page){background:radial-gradient(ellipse at 85% 0%,#7c3aed14,transparent 45%),radial-gradient(ellipse at 10% 0%,#5b21b60a,transparent 40%),var(--bg)}
body:has(.analytics-page) .top{background:linear-gradient(100deg,#7c3aed18,transparent 60%),var(--surface-muted);box-shadow:inset 0 -1px #7c3aed33}
body:has(.analytics-page) .side a[aria-current=page]{background:linear-gradient(110deg,#7c3aed26,#7c3aed08);border-left-color:var(--accent)}
.analytics-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:20px}
.analytics-header>div{min-width:0}
.analytics-header>div>p{margin-bottom:0}
.analytics-header h1{position:relative;font-size:30px;line-height:1.2;margin:0 0 8px;padding-left:16px}
.analytics-header h1:before{content:"";position:absolute;left:0;top:1px;width:4px;height:34px;background:var(--gradient-brand);border-radius:2px}
.analytics-header p,.analytics-settings>p,.analytics-channel-card>p,.analytics-settings-card>p{color:var(--muted);margin:0 0 16px}
.analytics-range{padding:0;border:0;background:none;margin:0;max-width:none;width:auto;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;flex-shrink:0}
.analytics-range label{display:flex;flex-direction:column;gap:8px}
.analytics-range button,.analytics-range select,.analytics-settings-card button,.analytics-settings-card input:not([type=checkbox]),.analytics-settings-card select{min-height:44px}
.analytics-page .analytics-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:0 0 22px}
.analytics-metric{position:relative;min-height:136px;padding:30px 20px 16px;border:1px solid var(--border);border-radius:14px;background:var(--gradient-surface);overflow:hidden}
.analytics-metric:before{content:"";position:absolute;top:18px;left:20px;width:42px;height:3px;background:var(--gradient-brand)}
.analytics-metric dt{font-size:12px;line-height:1.3;color:var(--muted)}
.analytics-metric dd{font-size:28px;line-height:1.2;font-weight:700;margin:6px 0}
.analytics-metric p{font-size:11px;line-height:1.35;color:var(--muted);margin:0}
.analytics-channel-card{min-height:250px;padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--surface);margin-bottom:26px;min-width:0}
.analytics-channel-card h2,.analytics-settings h2{font-size:18px;font-weight:600;line-height:1.3;margin:0 0 8px}
.analytics-channel-card>p{font-size:12px;line-height:1.35;margin:0 0 8px}
.analytics-settings>p{font-size:13px;line-height:1.35;margin:0 0 14px}
.analytics-channel-card .analytics-window{font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}
.analytics-page .analytics-metadata{display:grid;grid-template-columns:minmax(110px,auto) 1fr;gap:4px 16px;font-size:12px;margin:12px 0}
.analytics-metadata dt{color:var(--muted)}
.analytics-metadata dd{margin:0;overflow-wrap:anywhere}
.analytics-channel-card .table-wrap{overflow-x:auto;max-width:100%;margin-bottom:8px}
.analytics-channel-card th,.analytics-channel-card td{padding:8px 12px;font-size:12px;line-height:1.35}
.analytics-channel-card th{background:var(--surface-muted)}
.analytics-channel-card caption{padding:8px 12px;font-size:12px;line-height:1.35}
.analytics-channel-card > .table-wrap caption{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}
.analytics-additional{margin-top:8px;border-top:1px solid var(--border);padding-top:4px}
.analytics-additional summary{cursor:pointer;min-height:44px;display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.analytics-additional summary:before{content:"▸"}
.analytics-additional[open] summary:before{content:"▾"}
.analytics-additional h3{font-size:16px}
.analytics-additional h4{font-size:14px}
.analytics-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.analytics-settings-card{margin:0;display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto auto;gap:10px;min-width:0;padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--surface);max-width:none}
.analytics-settings-card>.analytics-settings-heading{grid-row:1}
.analytics-settings-card>p{grid-row:2}
.analytics-settings-card>input[type=hidden]{display:none}
.analytics-settings-card>label:not(.analytics-confirm){grid-row:3}
.analytics-settings-card>small{grid-row:4}
.analytics-settings-card>.analytics-confirm{grid-row:5}
.analytics-settings-card>button{grid-row:6;justify-self:start}
.analytics-settings-card h3{font-size:17px;font-weight:600;margin:0}
.analytics-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.analytics-settings-heading .status{flex-shrink:0}
.analytics-settings-card input:not([type=checkbox]),.analytics-settings-card select{border-radius:8px}
.analytics-range select,.analytics-range button{border-radius:10px}
.analytics-settings-card>p{font-size:13px;line-height:1.35;margin:0;min-height:36px}
.analytics-settings-card small{color:var(--muted)}
.analytics-confirm{display:flex;align-items:center;gap:10px;min-height:44px;font-size:13px}
.analytics-confirm input{flex-shrink:0}
.analytics-settings-card button{align-self:start;margin-top:0}
.analytics-range select,.analytics-settings-card select,.analytics-settings-card input{max-width:100%;min-width:0}

@supports(grid-template-rows:subgrid){
@media(min-width:769px){.analytics-settings-grid{grid-template-rows:repeat(6,auto);row-gap:10px}
.analytics-settings-card{grid-row:1 / span 6;grid-template-rows:subgrid}
}
}

@media(max-width:1279px){.analytics-page .analytics-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.analytics-header{flex-wrap:wrap}
}

@media(max-width:768px){.analytics-settings-grid{grid-template-columns:1fr}
.analytics-header{align-items:flex-start}
.analytics-range{width:100%}
.analytics-settings-card{grid-template-rows:auto auto auto auto auto auto}
.analytics-settings-card>p{min-height:0}
}

@media(max-width:430px){.analytics-page .analytics-metrics{grid-template-columns:1fr}
.analytics-channel-card,.analytics-settings-card{padding:16px}
.analytics-page .analytics-metadata{grid-template-columns:1fr}
.analytics-range{grid-template-columns:minmax(0,1fr) auto}
}

`;
