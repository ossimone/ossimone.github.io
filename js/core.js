/* Ortak durum, DOM referansları ve küçük yardımcılar. */

export const state = {
  files: new Map(),   // id -> {id, name, bytes, pdfDoc}
  pages: [],          // {id, fileId, srcIndex, rotation, annots:[], textOps:[]}
  index: 0,
  tool: 'select',
  zoom: 1,
  fitMode: 'page',
  dirty: false,
  selectedAnnot: null,
  selectedTextOp: null, // metin kutusu seçimi (op id)
  noteTarget: null,   // {mode, pageEntry, point}
  editTarget: null,
};

export const dom = {
  app: document.getElementById('app'),
  topbar: document.querySelector('.topbar'),
  docName: document.getElementById('docName'),
  docPages: document.getElementById('docPages'),
  dirtyDot: document.getElementById('dirtyDot'),
  btnOpen: document.getElementById('btnOpen'),
  btnOpen2: document.getElementById('btnOpen2'),
  btnSave: document.getElementById('btnSave'),
  btnHelp: document.getElementById('btnHelp'),
  btnSidebar: document.getElementById('btnSidebar'),
  sidebar: document.getElementById('sidebar'),
  btnAddPages: document.getElementById('btnAddPages'),
  btnFit: document.getElementById('btnFit'),
  btnNew: document.getElementById('btnNew'),
  thumbs: document.getElementById('thumbs'),
  stage: document.getElementById('stage'),
  emptyState: document.getElementById('emptyState'),
  dropZone: document.getElementById('dropZone'),
  scroller: document.getElementById('pageScroller'),
  pageWrap: document.getElementById('pageWrap'),
  canvas: document.getElementById('pageCanvas'),
  textLayer: document.getElementById('textLayer'),
  editLayer: document.getElementById('editLayer'),
  selLayer: document.getElementById('selLayer'),
  noteLayer: document.getElementById('noteLayer'),
  annotLayer: document.getElementById('annotLayer'),
  pager: document.getElementById('pager'),
  pageIndicator: document.getElementById('pageIndicator'),
  btnPrev: document.getElementById('btnPrev'),
  btnNext: document.getElementById('btnNext'),
  toolbar: document.getElementById('toolbar'),
  btnZoomIn: document.getElementById('btnZoomIn'),
  btnZoomOut: document.getElementById('btnZoomOut'),
  zoomLabel: document.getElementById('zoomLabel'),
  btnRotate: document.getElementById('btnRotate'),
  btnDeletePage: document.getElementById('btnDeletePage'),
  btnDeleteAnnot: document.getElementById('btnDeleteAnnot'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  modalSave: document.getElementById('modalSave'),
  saveName: document.getElementById('saveName'),
  saveApply: document.getElementById('saveApply'),
  modalText: document.getElementById('modalText'),
  inlineEditorWrap: document.getElementById('inlineEditorWrap'),
  editText: document.getElementById('editText'),
  editFont: document.getElementById('editFont'),
  editSize: document.getElementById('editSize'),
  editColor: document.getElementById('editColor'),
  editBoxWidth: document.getElementById('editBoxWidth'),
  editFit: document.getElementById('editFit'),
  editHint: document.getElementById('editHint'),
  editApply: document.getElementById('editApply'),
  editCoverOnly: document.getElementById('editCoverOnly'),
  editRevert: document.getElementById('editRevert'),
  modalNote: document.getElementById('modalNote'),
  noteTitle: document.getElementById('noteTitle'),
  noteText: document.getElementById('noteText'),
  noteColor: document.getElementById('noteColor'),
  noteSize: document.getElementById('noteSize'),
  noteApply: document.getElementById('noteApply'),
  modalHelp: document.getElementById('modalHelp'),
  toast: document.getElementById('toast'),
  toastText: document.getElementById('toastText'),
  toastAction: document.getElementById('toastAction'),
};

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export function pageKey(entry) {
  return entry.fileId + ':' + entry.srcIndex;
}

export function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/* ---- basit olay veriyolu ---- */
const bus = new EventTarget();
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
export function on(name, fn) { bus.addEventListener(name, fn); }

/* ---- bildirim ---- */
let toastTimer = 0;
export function toast(msg, action) {
  dom.toastText.textContent = msg;
  if (action && action.label) {
    dom.toastAction.hidden = false;
    dom.toastAction.textContent = action.label;
    dom.toastAction.onclick = () => { dom.toast.hidden = true; action.onClick?.(); };
  } else {
    dom.toastAction.hidden = true;
  }
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, action ? 7000 : 2800);
}

/* ---- modallar ---- */
export function openModal(el) {
  el.hidden = false;
  const first = el.querySelector('textarea, input, select');
  if (first && window.matchMedia('(min-width: 821px)').matches) setTimeout(() => first.focus(), 40);
}
export function closeModal(el) { el.hidden = true; }

export function setDirty(v = true) {
  state.dirty = v;
  dom.dirtyDot.hidden = !v;
}

export function loading(v, text = 'Yükleniyor…') {
  dom.loading.hidden = !v;
  dom.loadingText.textContent = text;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function hexToRgb(hex) {
  const s = hex.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function rgbCss(rgb, a = 1) {
  return a === 1 ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

export function isTouch() {
  return window.matchMedia('(pointer: coarse)').matches;
}

/* ---- dosya / belge yardımcıları ---- */
export function currentEntry() { return state.pages[state.index]; }
export function currentFile(entry = currentEntry()) {
  return entry ? state.files.get(entry.fileId) : null;
}
export function baseName(name) { return name.replace(/\.pdf$/i, ''); }
