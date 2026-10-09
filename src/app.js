// Interface: lista de imagens (arrastar, girar, reordenar), opções de página e
// qualidade, recompressão no canvas quando preciso e montagem do PDF.
import { parseJpeg, pngDpi, pngSize, insertExifOrientation, ImageFormatError } from './jpeg.js';
import { layoutPage, effectiveDpi } from './page.js';
import { buildPdf, estimatePdfSize } from './pdf.js';
import { needsReencode, fitWithin, toGrayscale, sortByName, moveItem, formatBytes, sniffType, pdfFileName } from './images.js';

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = 'imagens-para-pdf:opcoes';
const TYPE_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' };

const els = {
  drop: $('#drop'),
  files: $('#files'),
  toolbar: $('#toolbar'),
  count: $('#count'),
  sortName: $('#sort-name'),
  clear: $('#clear'),
  thumbs: $('#thumbs'),
  listMsg: $('#list-msg'),
  loadMsg: $('#load-msg'),
  margin: $('#margin'),
  noUpscale: $('#no-upscale'),
  keep: $('#keep'),
  quality: $('#quality'),
  qualityOut: $('#quality-out'),
  maxSide: $('#max-side'),
  gray: $('#gray'),
  filename: $('#filename'),
  title: $('#title'),
  estimate: $('#estimate'),
  generate: $('#generate'),
  openPdf: $('#open-pdf'),
  pdfMsg: $('#pdf-msg'),
};

let items = [];
let nextId = 1;
let browserAppliesExif = true;
let generation = 0;
let pdfUrl = null;
let dragId = null;

const radio = (name) => document.querySelector(`input[name="${name}"]:checked`).value;

function setNotes(container, notes) {
  container.replaceChildren(...notes.map(({ text, kind }) => {
    const p = document.createElement('p');
    if (kind) p.className = kind;
    p.textContent = text;
    return p;
  }));
}

function options() {
  return {
    size: radio('size'),
    orientation: radio('orientation'),
    marginMm: Number(els.margin.value),
    upscale: !els.noUpscale.checked,
    keepOriginals: els.keep.checked,
    quality: Number(els.quality.value),
    grayscale: els.gray.checked,
    maxSide: Number(els.maxSide.value),
  };
}

function saveOptions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options()));
  } catch {
    // sem armazenamento: as opções só não ficam salvas
  }
}

function loadOptions() {
  let o = null;
  try {
    o = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    o = null;
  }
  if (!o || typeof o !== 'object') return;
  const check = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${CSS.escape(String(value))}"]`);
    if (el) el.checked = true;
  };
  check('size', o.size);
  check('orientation', o.orientation);
  const pick = (el, v) => {
    if ([...el.options].some((op) => op.value === String(v))) el.value = String(v);
  };
  pick(els.margin, o.marginMm);
  pick(els.maxSide, o.maxSide);
  els.noUpscale.checked = o.upscale === false;
  els.keep.checked = o.keepOriginals !== false;
  els.gray.checked = Boolean(o.grayscale);
  if (Number(o.quality) >= 30 && Number(o.quality) <= 95) els.quality.value = String(o.quality);
}

/** Monta um JPEG de 2x1 pixel com orientação EXIF 6 e vê se o navegador o mostra em pé (1x2). */
async function detectExifSupport() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    canvas.getContext('2d').fillRect(0, 0, 2, 1);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    const bytes = insertExifOrientation(new Uint8Array(await blob.arrayBuffer()), 6);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    try {
      const img = await loadImage(url);
      return img.naturalWidth === 1 && img.naturalHeight === 2;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return true;
  }
}

function loadImage(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  return img.decode().then(() => img);
}

function processKey(item, o) {
  return needsReencode(item, o) ? `r|${o.quality}|${o.grayscale}|${o.maxSide}` : 'original';
}

async function prepare(item, o) {
  const key = processKey(item, o);
  if (item.prepared && item.prepared.key === key) return item.prepared;
  if (key === 'original') {
    const j = item.jpeg;
    item.prepared = {
      key, data: item.bytes, width: j.width, height: j.height, components: j.components, adobe: j.adobe,
      orientation: j.orientation, exactDpi: effectiveDpi(j.dpi),
    };
    return item.prepared;
  }
  const img = await loadImage(item.url);
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const { width, height } = fitWithin(srcW, srcH, o.maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparência vira branco, como no papel
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  if (o.grayscale) {
    const pixels = ctx.getImageData(0, 0, width, height);
    toGrayscale(pixels.data);
    ctx.putImageData(pixels, 0, 0);
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', o.quality / 100));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('O navegador não conseguiu recomprimir esta imagem.');
  const data = new Uint8Array(await blob.arrayBuffer());
  const info = parseJpeg(data);
  item.prepared = {
    key,
    data,
    width: info.width,
    height: info.height,
    components: info.components,
    adobe: info.adobe,
    // se o navegador já desenhou a foto em pé, a nova imagem não tem mais orientação EXIF
    orientation: item.type === 'jpeg' && !browserAppliesExif ? item.orientation : 1,
    exactDpi: effectiveDpi(item.dpi) * (width / srcW),
  };
  return item.prepared;
}

function describe(item) {
  if (item.error) return item.error;
  const parts = [];
  if (item.pixelWidth) parts.push(`${item.pixelWidth} × ${item.pixelHeight} px`);
  parts.push(`${TYPE_LABEL[item.type]}${item.jpeg?.progressive ? ' progressivo' : ''}`);
  parts.push(formatBytes(item.size));
  let text = parts.join(' · ');
  if (item.prepared) {
    text += item.prepared.key === 'original'
      ? ' · vai sem recompressão'
      : ` · recomprimida: ${formatBytes(item.prepared.data.length)}`;
  }
  return text;
}

function makeButton(label, text, action, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.dataset.action = action;
  b.disabled = disabled;
  return b;
}

function renderList(focus) {
  els.thumbs.replaceChildren(...items.map((item, index) => {
    const li = document.createElement('li');
    li.className = 'thumb';
    li.draggable = true;
    li.dataset.id = String(item.id);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(index + 1);
    num.setAttribute('aria-hidden', 'true');
    const frame = document.createElement('div');
    frame.className = 'frame';
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = `Página ${index + 1}: ${item.name}`;
    img.style.transform = `rotate(${item.rotation}deg)`;
    frame.append(img);
    const name = document.createElement('p');
    name.className = 'name';
    name.textContent = item.name;
    name.title = item.name;
    const meta = document.createElement('p');
    meta.className = item.error ? 'meta err' : 'meta';
    meta.textContent = describe(item);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    buttons.append(
      makeButton(`Girar ${item.name} para a esquerda`, '↺', 'left', Boolean(item.error)),
      makeButton(`Girar ${item.name} para a direita`, '↻', 'right', Boolean(item.error)),
      makeButton(`Mover ${item.name} para antes`, '◀', 'up', index === 0),
      makeButton(`Mover ${item.name} para depois`, '▶', 'down', index === items.length - 1),
      makeButton(`Remover ${item.name}`, '✕', 'remove'),
    );
    li.append(num, frame, name, meta, buttons);
    return li;
  }));
  const ok = items.filter((it) => !it.error).length;
  els.toolbar.hidden = items.length === 0;
  els.count.textContent = `${ok} ${ok === 1 ? 'imagem' : 'imagens'}${items.length > ok ? ` (${items.length - ok} com erro)` : ''}`;
  if (focus) {
    const btn = els.thumbs.querySelector(`li[data-id="${focus.id}"] button[data-action="${focus.action}"]`);
    (btn && !btn.disabled ? btn : els.thumbs.querySelector(`li[data-id="${focus.id}"] button[data-action="remove"]`))?.focus();
  }
}

function updateMeta(item) {
  const meta = els.thumbs.querySelector(`li[data-id="${item.id}"] .meta`);
  if (meta) {
    meta.textContent = describe(item);
    meta.className = item.error ? 'meta err' : 'meta';
  }
}

async function processAll() {
  const gen = ++generation;
  const o = options();
  const ready = items.filter((it) => !it.error);
  els.generate.disabled = true;
  if (!ready.length) {
    els.estimate.textContent = items.length ? 'Nenhuma imagem válida.' : 'Adicione imagens para começar.';
    return false;
  }
  let done = 0;
  for (const item of ready) {
    if (gen !== generation) return null;
    if (!(item.prepared && item.prepared.key === processKey(item, o))) {
      els.estimate.textContent = `Preparando as imagens: ${done} de ${ready.length}...`;
    }
    try {
      await prepare(item, o);
    } catch (err) {
      item.error = `Não foi possível processar: ${err.message}`;
    }
    done++;
    updateMeta(item);
  }
  if (gen !== generation) return null;
  const valid = items.filter((it) => !it.error && it.prepared);
  if (!valid.length) {
    els.estimate.textContent = 'Nenhuma imagem válida.';
    return false;
  }
  const size = estimatePdfSize(valid.map((it) => it.prepared.data.length));
  els.estimate.textContent = `${valid.length} ${valid.length === 1 ? 'página' : 'páginas'} · tamanho estimado: ${formatBytes(size)}`;
  els.generate.disabled = false;
  return true;
}

function invalidatePdf() {
  if (pdfUrl) {
    URL.revokeObjectURL(pdfUrl);
    pdfUrl = null;
  }
  els.openPdf.hidden = true;
  setNotes(els.pdfMsg, []);
}

function changed() {
  saveOptions();
  invalidatePdf();
  els.qualityOut.textContent = `${els.quality.value}%`;
  const fit = radio('size') === 'fit';
  for (const r of document.querySelectorAll('input[name="orientation"]')) r.disabled = fit;
  processAll();
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const problems = [];
  const added = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      problems.push(`${file.name}: não foi possível ler o arquivo.`);
      continue;
    }
    const type = sniffType(bytes);
    if (!type) {
      const heic = /\.(heic|heif)$/i.test(file.name);
      problems.push(heic
        ? `${file.name}: HEIC (padrão das fotos de iPhone) não é aberto pelos navegadores; exporte como JPEG.`
        : `${file.name}: não é JPEG, PNG nem WebP.`);
      continue;
    }
    const item = { id: nextId++, name: file.name, size: file.size, type, bytes, rotation: 0, orientation: 1, dpi: 0, prepared: null };
    try {
      if (type === 'jpeg') {
        item.jpeg = parseJpeg(bytes);
        item.pixelWidth = item.jpeg.width;
        item.pixelHeight = item.jpeg.height;
        item.orientation = item.jpeg.orientation;
        item.dpi = item.jpeg.dpi;
        if (item.orientation >= 5) [item.pixelWidth, item.pixelHeight] = [item.pixelHeight, item.pixelWidth];
      } else if (type === 'png') {
        const s = pngSize(bytes);
        item.pixelWidth = s?.width;
        item.pixelHeight = s?.height;
        item.dpi = pngDpi(bytes);
      }
    } catch (err) {
      if (!(err instanceof ImageFormatError)) throw err;
      problems.push(`${file.name}: ${err.message}`);
      continue;
    }
    item.url = URL.createObjectURL(new Blob([bytes], { type: `image/${type}` }));
    if (!item.pixelWidth) {
      try {
        const img = await loadImage(item.url);
        item.pixelWidth = img.naturalWidth;
        item.pixelHeight = img.naturalHeight;
      } catch {
        item.error = 'O navegador não conseguiu abrir esta imagem.';
      }
    }
    added.push(item);
  }
  items = [...items, ...added];
  setNotes(els.loadMsg, problems.map((text) => ({ text, kind: 'error' })));
  els.listMsg.textContent = added.length ? `${added.length} ${added.length === 1 ? 'imagem adicionada' : 'imagens adicionadas'}.` : '';
  invalidatePdf();
  renderList();
  processAll();
}

function removeItem(id) {
  const item = items.find((it) => it.id === id);
  if (item) URL.revokeObjectURL(item.url);
  items = items.filter((it) => it.id !== id);
}

els.thumbs.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const id = Number(button.closest('li').dataset.id);
  const index = items.findIndex((it) => it.id === id);
  const item = items[index];
  const action = button.dataset.action;
  invalidatePdf();
  if (action === 'left' || action === 'right') {
    item.rotation = (item.rotation + (action === 'left' ? 270 : 90)) % 360;
    els.listMsg.textContent = `${item.name} girada para ${item.rotation} graus.`;
    renderList({ id, action });
    processAll();
  } else if (action === 'up' || action === 'down') {
    const to = index + (action === 'up' ? -1 : 1);
    items = moveItem(items, index, to);
    els.listMsg.textContent = `${item.name} agora é a página ${to + 1}.`;
    renderList({ id, action });
  } else if (action === 'remove') {
    removeItem(id);
    els.listMsg.textContent = `${item.name} removida.`;
    renderList();
    const next = els.thumbs.querySelectorAll('li')[Math.min(index, items.length - 1)];
    next?.querySelector('button[data-action="remove"]')?.focus();
    processAll();
  }
});

// Reordenar arrastando
els.thumbs.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li.thumb');
  if (!li) return;
  dragId = Number(li.dataset.id);
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.id);
});
els.thumbs.addEventListener('dragover', (e) => {
  if (dragId === null) return;
  const li = e.target.closest('li.thumb');
  e.preventDefault();
  for (const el of els.thumbs.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
  if (!li || Number(li.dataset.id) === dragId) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
});
els.thumbs.addEventListener('drop', (e) => {
  if (dragId === null) return;
  e.preventDefault();
  const li = e.target.closest('li.thumb');
  if (li && Number(li.dataset.id) !== dragId) {
    const from = items.findIndex((it) => it.id === dragId);
    let to = items.findIndex((it) => it.id === Number(li.dataset.id));
    const r = li.getBoundingClientRect();
    if (e.clientX >= r.left + r.width / 2) to += 1;
    if (from < to) to -= 1;
    items = moveItem(items, from, to);
    invalidatePdf();
    els.listMsg.textContent = `${items[to].name} agora é a página ${to + 1}.`;
    renderList();
  }
});
els.thumbs.addEventListener('dragend', () => {
  dragId = null;
  for (const el of els.thumbs.querySelectorAll('.dragging, .drop-before, .drop-after')) el.classList.remove('dragging', 'drop-before', 'drop-after');
});

// Arquivos arrastados para a área ou escolhidos no seletor
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
els.drop.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  els.drop.classList.remove('over');
  addFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  }
});
els.files.addEventListener('change', () => {
  addFiles(els.files.files);
  els.files.value = '';
});

els.sortName.addEventListener('click', () => {
  items = sortByName(items);
  invalidatePdf();
  els.listMsg.textContent = 'Imagens ordenadas por nome.';
  renderList();
});
els.clear.addEventListener('click', () => {
  for (const it of items) URL.revokeObjectURL(it.url);
  items = [];
  invalidatePdf();
  setNotes(els.loadMsg, []);
  els.listMsg.textContent = 'Todas as imagens foram removidas.';
  renderList();
  processAll();
});

for (const el of document.querySelectorAll('input[name="size"], input[name="orientation"]')) el.addEventListener('change', changed);
for (const el of [els.margin, els.noUpscale, els.keep, els.maxSide, els.gray]) el.addEventListener('change', changed);
els.quality.addEventListener('input', () => {
  els.qualityOut.textContent = `${els.quality.value}%`;
});
els.quality.addEventListener('change', changed);
for (const el of [els.filename, els.title]) el.addEventListener('input', invalidatePdf);

els.generate.addEventListener('click', async () => {
  els.generate.disabled = true;
  setNotes(els.pdfMsg, [{ text: 'Montando o PDF...' }]);
  try {
    const ready = await processAll();
    if (ready === null) {
      setNotes(els.pdfMsg, [{ text: 'As opções mudaram durante a preparação; clique de novo em Gerar PDF.', kind: 'warn' }]);
      return;
    }
    if (!ready) {
      setNotes(els.pdfMsg, [{ text: 'Não há imagens válidas para o PDF.', kind: 'error' }]);
      return;
    }
    const o = options();
    const pages = items.filter((it) => !it.error && it.prepared).map((it) => {
      const p = it.prepared;
      const lay = layoutPage(
        { width: p.width, height: p.height, orientation: p.orientation, exactDpi: p.exactDpi },
        { size: o.size, orientation: o.orientation, marginMm: o.marginMm, rotation: it.rotation, upscale: o.upscale },
      );
      return {
        width: lay.page.width,
        height: lay.page.height,
        matrix: lay.matrix,
        image: { data: p.data, width: p.width, height: p.height, components: p.components, adobe: p.adobe },
      };
    });
    const bytes = buildPdf(pages, { title: els.title.value.trim() || undefined });
    invalidatePdf();
    pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const name = pdfFileName(els.filename.value);
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    els.openPdf.href = pdfUrl;
    els.openPdf.hidden = false;
    setNotes(els.pdfMsg, [{ text: `${name} pronto: ${pages.length} ${pages.length === 1 ? 'página' : 'páginas'}, ${formatBytes(bytes.length)}.`, kind: 'ok' }]);
  } catch (err) {
    setNotes(els.pdfMsg, [{ text: err instanceof RangeError ? err.message : `Não foi possível gerar o PDF: ${err.message}`, kind: 'error' }]);
  } finally {
    els.generate.disabled = !items.some((it) => !it.error);
  }
});

loadOptions();
els.qualityOut.textContent = `${els.quality.value}%`;
for (const r of document.querySelectorAll('input[name="orientation"]')) r.disabled = radio('size') === 'fit';
detectExifSupport().then((applies) => {
  browserAppliesExif = applies;
});
renderList();
processAll();
