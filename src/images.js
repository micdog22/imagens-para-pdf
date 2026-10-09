// Decisões e contas sobre as imagens, sem DOM: quando recomprimir, como
// reduzir, conversão para tons de cinza, ordenação por nome e formatação.
import { pdfCompatible } from './jpeg.js';

/**
 * Diz se a imagem precisa passar pelo canvas: só JPEGs compatíveis com o PDF
 * vão sem recompressão, e só quando a pessoa pediu para manter os originais,
 * sem tons de cinza e sem redução de tamanho.
 */
export function needsReencode(item, { keepOriginals = true, grayscale = false, maxSide = 0 } = {}) {
  if (!item.jpeg || !pdfCompatible(item.jpeg)) return true;
  if (!keepOriginals || grayscale) return true;
  return maxSide > 0 && Math.max(item.jpeg.width, item.jpeg.height) > maxSide;
}

/** Dimensões depois de limitar o lado maior a maxSide (0 = sem limite). */
export function fitWithin(width, height, maxSide) {
  if (!maxSide || Math.max(width, height) <= maxSide) return { width, height };
  const k = maxSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/**
 * Converte pixels RGBA para tons de cinza no próprio array, com os pesos de
 * luminância da recomendação BT.601 (os mesmos do JPEG): 0,299 R + 0,587 G + 0,114 B.
 * Pixels transparentes já devem ter sido compostos sobre branco.
 */
export function toGrayscale(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const y = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    rgba[i] = y;
    rgba[i + 1] = y;
    rgba[i + 2] = y;
  }
  return rgba;
}

/** Ordena por nome como as pessoas esperam: "foto 2" antes de "foto 10". */
export function sortByName(items) {
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => collator.compare(a.name, b.name));
}

/** Move o item da posição from para a posição to (índices de 0 em diante). */
export function moveItem(list, from, to) {
  const copy = [...list];
  if (from < 0 || from >= copy.length) return copy;
  const [item] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(to, copy.length)), 0, item);
  return copy;
}

/** Tamanho de arquivo legível em português: 980 bytes, 12,3 KB, 4,56 MB. */
export function formatBytes(n) {
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

/** Tipo de imagem pelos primeiros bytes (a extensão do arquivo pode mentir). */
export function sniffType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

/** Nome de arquivo seguro terminado em .pdf. */
export function pdfFileName(input) {
  const base = String(input ?? '').trim().replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100).trim();
  return `${base || 'imagens'}.pdf`;
}
