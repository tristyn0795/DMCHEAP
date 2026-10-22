// Small DOM helpers shared by the hideout and the in-raid inventory.
import { ITEMS, RARITY, AMMO_TYPES } from '/shared/data.js';
import { weaponStats, gunName, JAM_BELOW } from '/shared/gunsmith.js';
import { gunIcon, attIcon } from './guns.js';

export const $ = (s, r = document) => r.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => '$' + Math.round(n).toLocaleString();

export function itemSub(s) {
  const it = ITEMS[s.id];
  if (!it) return '';
  if (it.type === 'weapon') {
    const st = weaponStats(s);
    if (s.mag == null) return `${st.cls} · ${st.mag} rds · ${st.mode}`; // shop listing (no instance yet)
    const dur = Math.round(s.dur ?? 100);
    return `${st.cls} · ${s.mag ?? 0}/${st.mag}${(s.ammoType ?? 'fmj') !== 'fmj' ? ' ' + AMMO_TYPES[s.ammoType].name : ''} · ${dur < JAM_BELOW ? '⚠ ' : ''}${dur}%`;
  }
  if (it.type === 'attachment') return `Attachment · ${it.slot}`;
  if (it.type === 'shield') return `Shield ${Math.round(s.charge ?? 0)}/${it.cap}`;
  if (it.type === 'rig') return `${it.slots} slots · ${it.safe} safe`;
  if (it.type === 'ammo') return 'Ammo';
  return it.type[0].toUpperCase() + it.type.slice(1);
}

export function itemHTML(s, { idx, src, insured } = {}) {
  if (!s) return `<div class="item empty">empty</div>`;
  const it = ITEMS[s.id] ?? { name: s.id, rarity: 'common' };
  const rc = RARITY[it.rarity]?.color ?? '#888';
  const name = it.type === 'weapon' ? gunName(s) : it.name;
  const icon = it.type === 'weapon' ? gunIcon(s) : it.type === 'attachment' ? attIcon(s.id) : null;
  return `<div class="item${icon ? ' has-icon' : ''}" style="--rc:${rc}" data-idx="${idx ?? ''}" data-src="${src ?? ''}" title="${esc(it.desc ?? name)}">
    ${icon ? `<img class="ico" src="${icon}" alt="">` : ''}<div class="nm">${esc(name)}</div><div class="sub">${esc(itemSub(s))}</div>
    ${s.qty > 1 ? `<div class="q">x${s.qty}</div>` : ''}${insured ? '<div class="ins">INSURED</div>' : ''}</div>`;
}

let ctxEl = null;
export function showMenu(x, y, title, entries) {
  ctxEl = ctxEl ?? document.getElementById('ctx');
  ctxEl.innerHTML = `<div class="ttl">${esc(title)}</div>` + entries.map((e, i) => `<button data-i="${i}" ${e.disabled ? 'disabled' : ''}>${esc(e.label)}</button>`).join('');
  ctxEl.classList.remove('hidden');
  const w = 200, h = 34 * entries.length + 40;
  ctxEl.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  ctxEl.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  ctxEl.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    hideMenu();
    entries[+b.dataset.i].fn();
  };
}
export function hideMenu() { ctxEl?.classList.add('hidden'); }
document.addEventListener('mousedown', (ev) => { if (ctxEl && !ctxEl.contains(ev.target)) hideMenu(); });

export function toast(text, err = false) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' err' : '');
  d.textContent = text;
  box.appendChild(d);
  setTimeout(() => d.remove(), err ? 5000 : 4000);
}
