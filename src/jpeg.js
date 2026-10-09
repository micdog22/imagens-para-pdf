// Leitura dos marcadores de um JPEG, sem decodificar a imagem: dimensões e
// componentes (segmento SOF), tipo de compressão (baseline ou progressiva),
// orientação EXIF, densidade (dpi) e o marcador Adobe. É o suficiente para
// colocar os bytes originais num PDF com o filtro DCTDecode.

export class ImageFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageFormatError';
  }
}

const SOF_NAMES = {
  0xc0: 'baseline', 0xc1: 'sequencial estendido', 0xc2: 'progressivo', 0xc3: 'sem perdas',
  0xc5: 'hierárquico', 0xc6: 'hierárquico progressivo', 0xc7: 'hierárquico sem perdas',
  0xc9: 'aritmético', 0xca: 'aritmético progressivo', 0xcb: 'aritmético sem perdas',
  0xcd: 'aritmético hierárquico', 0xce: 'aritmético hierárquico progressivo', 0xcf: 'aritmético hierárquico sem perdas',
};

/** Diz se os bytes começam como um JPEG (marcador SOI). */
export function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function u16(bytes, i, little = false) {
  return little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
}

function u32(bytes, i, little = false) {
  return little
    ? (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0
    : ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

/**
 * Lê o bloco EXIF (APP1): cabeçalho TIFF ("II" ou "MM"), IFD0 e as tags de
 * orientação (0x0112) e resolução (0x011A, 0x0128).
 */
export function parseExif(segment) {
  // segment começa em "Exif\0\0"
  if (segment.length < 14 || String.fromCharCode(...segment.subarray(0, 4)) !== 'Exif') return null;
  const tiff = segment.subarray(6);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  if (u16(tiff, 2, little) !== 42) return null;
  const ifd = u32(tiff, 4, little);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(tiff, ifd, little);
  const out = { orientation: 0, xResolution: 0, resolutionUnit: 2 }; // orientação 0 = ausente
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(tiff, e, little);
    const type = u16(tiff, e + 2, little);
    if (tag === 0x0112 && type === 3) {
      const v = u16(tiff, e + 8, little);
      if (v >= 1 && v <= 8) out.orientation = v;
    } else if (tag === 0x0128 && type === 3) {
      out.resolutionUnit = u16(tiff, e + 8, little);
    } else if (tag === 0x011a && type === 5) {
      const off = u32(tiff, e + 8, little);
      if (off + 8 <= tiff.length) {
        const num = u32(tiff, off, little);
        const den = u32(tiff, off + 4, little);
        if (den) out.xResolution = num / den;
      }
    }
  }
  return out;
}

/**
 * Percorre os segmentos até o primeiro SOS. Devolve largura, altura,
 * componentes, precisão, tipo de SOF, orientação EXIF, dpi e o marcador Adobe.
 */
export function parseJpeg(bytes) {
  if (!isJpeg(bytes)) throw new ImageFormatError('O arquivo não é um JPEG (falta o marcador SOI).');
  const info = {
    width: 0, height: 0, components: 0, precision: 0, sof: 0, process: '', progressive: false,
    orientation: 1, dpi: 0, adobe: null, jfif: false,
  };
  let orientation = 0;
  let exifDpi = 0;
  let jfifDpi = 0;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new ImageFormatError(`JPEG corrompido: marcador esperado na posição ${i}.`);
    while (i < bytes.length && bytes[i] === 0xff) i++; // bytes de preenchimento
    if (i >= bytes.length) break;
    const marker = bytes[i++];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // sem comprimento
    if (marker === 0xd9) break; // EOI
    if (i + 2 > bytes.length) throw new ImageFormatError('JPEG cortado no meio de um segmento.');
    const length = u16(bytes, i);
    if (length < 2 || i + length > bytes.length) throw new ImageFormatError('JPEG cortado no meio de um segmento.');
    const seg = bytes.subarray(i + 2, i + length);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (seg.length < 6) throw new ImageFormatError('Segmento SOF inválido.');
      info.sof = marker;
      info.process = SOF_NAMES[marker] ?? 'desconhecido';
      info.progressive = [0xc2, 0xc6, 0xca, 0xce].includes(marker);
      info.precision = seg[0];
      info.height = u16(seg, 1);
      info.width = u16(seg, 3);
      info.components = seg[5];
    } else if (marker === 0xe0 && seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === 'JFIF\0') {
      info.jfif = true;
      const units = seg[7];
      const xd = u16(seg, 8);
      if (units === 1) jfifDpi = xd;
      else if (units === 2) jfifDpi = xd * 2.54;
    } else if (marker === 0xe1) {
      // pode haver mais de um bloco EXIF: vale o primeiro que tiver cada informação
      const exif = parseExif(seg);
      if (exif) {
        if (!orientation && exif.orientation) orientation = exif.orientation;
        if (!exifDpi && exif.xResolution) {
          exifDpi = exif.resolutionUnit === 3 ? exif.xResolution * 2.54 : exif.xResolution;
        }
      }
    } else if (marker === 0xee && seg.length >= 12 && String.fromCharCode(...seg.subarray(0, 5)) === 'Adobe') {
      info.adobe = { transform: seg[11] };
    } else if (marker === 0xda) {
      break; // começo dos dados comprimidos
    }
    i += length;
  }
  if (!info.sof) throw new ImageFormatError('JPEG sem segmento SOF: não foi possível ler as dimensões.');
  if (!info.width || !info.height) throw new ImageFormatError('JPEG com dimensões inválidas.');
  info.orientation = orientation || 1;
  info.dpi = Math.round((jfifDpi || exifDpi) * 100) / 100;
  return info;
}

/**
 * Diz se os bytes podem ir direto para o PDF (DCTDecode): Huffman baseline,
 * estendido ou progressivo, 8 bits, com 1 ou 3 componentes. CMYK (4
 * componentes) e variantes raras são recomprimidos pelo navegador.
 */
export function pdfCompatible(info) {
  return [0xc0, 0xc1, 0xc2].includes(info.sof) && info.precision === 8 && (info.components === 1 || info.components === 3);
}

/** Densidade gravada num PNG (bloco pHYs), em dpi; 0 quando não há. */
export function pngDpi(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || sig.some((b, k) => bytes[k] !== b)) return 0;
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = u32(bytes, i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    if (type === 'pHYs' && len >= 9 && i + 8 + 9 <= bytes.length) {
      const ppu = u32(bytes, i + 8);
      const unit = bytes[i + 16];
      return unit === 1 ? Math.round(ppu * 0.0254 * 100) / 100 : 0;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return 0;
}

/**
 * Insere um bloco EXIF mínimo (só a orientação) num JPEG, logo depois do SOI
 * e do APP0 JFIF, se houver. Serve para montar a imagem de teste que mostra
 * se o navegador aplica a orientação EXIF ao desenhar no canvas.
 */
export function insertExifOrientation(bytes, orientation) {
  if (!isJpeg(bytes)) throw new ImageFormatError('O arquivo não é um JPEG.');
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0" + TIFF big endian
  const len = payload.length + 2;
  const app1 = new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + u16(bytes, 4);
  const out = new Uint8Array(bytes.length + app1.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(app1, at);
  out.set(bytes.subarray(at), at + app1.length);
  return out;
}

/** Largura e altura de um PNG, lidas do IHDR. */
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { width: u32(bytes, 16), height: u32(bytes, 20) };
}
