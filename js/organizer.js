/* Sayfa küçük resimleri, sıralama, döndürme ve silme. */

import { state, dom, on, emit, setDirty, toast, clamp } from './core.js';
import { renderThumb, updateChrome } from './render.js';

let thumbToken = 0;
let dragFrom = -1;

const ICONS = {
  rotate: '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.3-5.2M19 4.5V9h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M14.5 6 9 12l5.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9.5 6 15 12l-5.5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5.5 7h13M9.5 7V5.2h5V7M7.5 7l.8 12.2h7.4L16.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function initOrganizer() {
  on('pages:changed', () => { refreshThumbs(); });
  on('page:rendered', () => markActive());
}

export async function refreshThumbs() {
  const token = ++thumbToken;
  dom.thumbs.textContent = '';
  const jobs = [];

  state.pages.forEach((entry, idx) => {
    const card = document.createElement('div');
    card.className = 'thumb' + (idx === state.index ? ' active' : '');
    card.draggable = true;
    card.dataset.idx = String(idx);

    const no = document.createElement('span');
    no.className = 'thumb-no';
    no.textContent = String(idx + 1);

    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas';

    const tools = document.createElement('div');
    tools.className = 'thumb-tools';
    tools.appendChild(mkBtn(ICONS.rotate, 'Döndür', (e) => { e.stopPropagation(); rotatePage(idx); }));
    tools.appendChild(mkBtn(ICONS.left, 'Sola taşı', (e) => { e.stopPropagation(); movePage(idx, idx - 1); }));
    tools.appendChild(mkBtn(ICONS.right, 'Sağa taşı', (e) => { e.stopPropagation(); movePage(idx, idx + 1); }));
    const del = mkBtn(ICONS.del, 'Sayfayı sil', (e) => { e.stopPropagation(); deletePage(idx); });
    del.classList.add('del');
    tools.appendChild(del);

    card.append(canvas, no, tools);
    card.addEventListener('click', () => goTo(idx));
    card.addEventListener('dragstart', (e) => {
      dragFrom = idx;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch { /* yoksay */ }
      card.style.opacity = '.55';
    });
    card.addEventListener('dragend', () => { card.style.opacity = ''; dragFrom = -1; clearDropHints(); });
    card.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      clearDropHints();
      card.classList.add(dragFrom < idx ? 'drop-after' : 'drop-before');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom < 0) return;
      const to = idx;
      clearDropHints();
      if (dragFrom !== to) movePage(dragFrom, to);
      dragFrom = -1;
    });

    dom.thumbs.appendChild(card);
    jobs.push({ entry, canvas, idx });
  });

  // küçük resimleri sınırlı eşzamanlılıkla çiz
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (token !== thumbToken) return;
      try {
        await renderThumb(job.entry, job.canvas, 116);
      } catch (err) {
        console.warn('Küçük resim çizilemedi', err);
      }
    }
  });
  await Promise.all(workers);
  if (token !== thumbToken) return;
  markActive();
}

function mkBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = title;
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

function clearDropHints() {
  dom.thumbs.querySelectorAll('.thumb').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

function markActive() {
  dom.thumbs.querySelectorAll('.thumb').forEach(el => {
    const on2 = Number(el.dataset.idx) === state.index;
    el.classList.toggle('active', on2);
    if (on2) el.scrollIntoView({ block: 'nearest' });
  });
}

export function goTo(idx) {
  if (!state.pages.length) return;
  const next = clamp(idx, 0, state.pages.length - 1);
  if (next === state.index) { emit('goto'); return; }
  state.index = next;
  state.selectedAnnot = null;
  dom.btnDeleteAnnot.hidden = true;
  emit('goto');
}

export function rotatePage(idx, dir = 1) {
  const entry = state.pages[idx];
  if (!entry) return;
  entry.rotation = ((entry.rotation || 0) + 90 * dir + 360) % 360;
  setDirty();
  emit('pages:changed');
  if (idx === state.index) emit('goto');
}

export function movePage(from, to) {
  if (from < 0 || from >= state.pages.length) return;
  to = clamp(to, 0, state.pages.length - 1);
  if (from === to) return;
  const cur = state.pages[state.index];
  const [p] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, p);
  const newIdx = state.pages.indexOf(cur);
  if (newIdx >= 0) state.index = newIdx;
  setDirty();
  emit('pages:changed');
  emit('goto');
}

export function deletePage(idx) {
  if (!state.pages.length) return;
  const entry = state.pages[idx];
  if (!entry) return;
  state.pages.splice(idx, 1);
  if (idx < state.index) state.index--;
  if (state.index >= state.pages.length) state.index = Math.max(0, state.pages.length - 1);
  state.selectedAnnot = null;
  setDirty();
  toast('Sayfa silindi');
  emit('pages:changed');
  emit('goto');
  updateChrome();
}

export function rotateCurrent() { rotatePage(state.index); }
export function deleteCurrent() { deletePage(state.index); }
