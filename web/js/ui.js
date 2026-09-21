'use strict';

/* ---------- 应用内对话框 ----------
 * 不用 window.prompt / window.confirm：
 *   - Tauri 没实现原生 prompt（官方 issue #4783），桌面端常见行为是直接返回 null；
 *   - Tauri v2 + WebView2 桌面实测 confirm 是 no-op，不弹框直接返回 true，
 *     所有「确认后删除/清空」会被静默绕过，属数据丢失隐患。
 * 所以一律自绘模态框 + Promise，浏览器与桌面同一套代码。
 * 同一时刻只保留一个遮罩（uiOverlay 会先关掉上一个），cleanup 时统一收掉。 */
let __modalEl = null;
function uiOverlay(inner) {
  if (__modalEl) { __modalEl.remove(); __modalEl = null; }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:60;display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:20px;width:min(480px,92vw);max-height:86vh;overflow:auto;';
  card.innerHTML = inner;
  box.appendChild(card);
  document.body.appendChild(box);
  __modalEl = box;
  return { box: box, card: card };
}
function uiCloseModal() { if (__modalEl) { __modalEl.remove(); __modalEl = null; } }
function uiBtnRow(yesLabel) {
  return '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">' +
    '<button class="btn" data-uicancel>取消</button>' +
    '<button class="btn btn-primary" data-uiok>' + (yesLabel || '确定') + '</button></div>';
}

/* 确认框 → Promise<boolean>，点遮罩/取消都视为 false */
function askConfirm(message, okText) {
  return new Promise(resolve => {
    const o = uiOverlay(
      '<div style="font-weight:500;margin-bottom:6px;white-space:pre-wrap;line-height:1.7;">' + esc(message) + '</div>' +
      uiBtnRow(okText));
    const done = v => { if (!__modalEl) return; uiCloseModal(); resolve(v); };
    o.card.querySelector('[data-uicancel]').addEventListener('click', () => done(false));
    o.card.querySelector('[data-uiok]').addEventListener('click', () => done(true));
    o.box.addEventListener('click', e => { if (e.target === o.box) done(false); });
  });
}

/* 表单框 → Promise<对象|null>。字段：{key,label,type:'text'|'number'|'select'|'checks',options,value,placeholder} */
function askForm(title, fields) {
  return new Promise(resolve => {
    const body = fields.map(f => {
      if (f.type === 'select') {
        return '<div style="margin-bottom:12px;"><div class="hint" style="margin-bottom:4px;">' + esc(f.label) + '</div>' +
          '<select class="field" data-k="' + esc(f.key) + '">' +
          (f.options || []).map(o => '<option value="' + esc(o.value) + '"' +
            (String(o.value) === String(f.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +
          '</select></div>';
      }
      if (f.type === 'checks') {
        return '<div style="margin-bottom:12px;"><div class="hint" style="margin-bottom:4px;">' + esc(f.label) + '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;">' + (f.options || []).map(o =>
            '<label style="font-size:13px;display:flex;gap:5px;align-items:center;cursor:pointer;">' +
            '<input type="checkbox" data-ck="' + esc(o.value) + '"' +
            ((f.value || []).indexOf(o.value) >= 0 ? ' checked' : '') + '> ' + esc(o.label) + '</label>').join('') +
          '</div></div>';
      }
      return '<div style="margin-bottom:12px;"><div class="hint" style="margin-bottom:4px;">' + esc(f.label) + '</div>' +
        '<input class="field" type="' + (f.type || 'text') + '" data-k="' + esc(f.key) + '" value="' +
        esc(f.value == null ? '' : f.value) + '"' +
        (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '></div>';
    }).join('');
    const o = uiOverlay('<div style="font-weight:500;margin-bottom:14px;">' + esc(title) + '</div>' + body + uiBtnRow('确定'));
    const done = v => { if (!__modalEl) return; uiCloseModal(); resolve(v); };
    o.card.querySelector('[data-uicancel]').addEventListener('click', () => done(null));
    o.card.querySelector('[data-uiok]').addEventListener('click', () => {
      const out = {};
      fields.forEach(f => {
        if (f.type === 'checks') {
          const picked = [];
          o.card.querySelectorAll('[data-ck]').forEach(c => { if (c.checked) picked.push(c.dataset.ck); });
          out[f.key] = picked;
        } else {
          const el = o.card.querySelector('[data-k="' + f.key + '"]');
          out[f.key] = el ? el.value : '';
        }
      });
      done(out);
    });
    o.box.addEventListener('click', e => { if (e.target === o.box) done(null); });
    const first = o.card.querySelector('input,select');
    if (first) first.focus();
  });
}
