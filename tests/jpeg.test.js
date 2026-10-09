import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJpeg, parseExif, pdfCompatible, pngDpi, isJpeg, ImageFormatError } from '../src/jpeg.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

// Monta um JPEG sintético só com marcadores (o suficiente para o leitor).
function segment(marker, payload) {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...payload];
}
function sof(marker, { precision = 8, width = 640, height = 480, components = 3 } = {}) {
  const comps = [];
  for (let c = 0; c < components; c++) comps.push(c + 1, 0x11, 0);
  return segment(marker, [precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...comps]);
}
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const jpeg = (...parts) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2, 0xff, 0xd9]);

test('JPEG baseline real: dimensões, componentes e densidade', () => {
  const info = parseJpeg(fixture('baseline-16x8.jpg'));
  assert.equal(info.width, 16);
  assert.equal(info.height, 8);
  assert.equal(info.components, 3);
  assert.equal(info.precision, 8);
  assert.equal(info.sof, 0xc0);
  assert.equal(info.process, 'baseline');
  assert.equal(info.progressive, false);
  assert.equal(info.orientation, 1);
  assert.equal(info.dpi, 72);
  assert.equal(info.jfif, true);
  assert.ok(pdfCompatible(info));
});

test('JPEG progressivo real (SOF2)', () => {
  const info = parseJpeg(fixture('progressivo-16x8.jpg'));
  assert.equal(info.sof, 0xc2);
  assert.equal(info.progressive, true);
  assert.equal(info.process, 'progressivo');
  assert.equal(info.width, 16);
  assert.ok(pdfCompatible(info));
});

test('orientação EXIF, tons de cinza e 300 dpi em arquivos reais', () => {
  assert.equal(parseJpeg(fixture('exif6-16x8.jpg')).orientation, 6);
  const gray = parseJpeg(fixture('cinza-300dpi-8x8.jpg'));
  assert.equal(gray.components, 1);
  assert.equal(gray.dpi, 300);
  assert.equal(pngDpi(fixture('png-300dpi-4x4.png')), 300);
  assert.equal(pngDpi(fixture('baseline-16x8.jpg')), 0);
});

test('marcadores sintéticos: preenchimento, RST, APPn antes do SOF e SOF1', () => {
  const bytes = jpeg([0xff, 0xff], segment(0xe2, [1, 2, 3]), [0xff, 0xd0], sof(0xc1, { width: 1234, height: 567 }));
  const info = parseJpeg(bytes);
  assert.equal(info.width, 1234);
  assert.equal(info.height, 567);
  assert.equal(info.process, 'sequencial estendido');
  assert.ok(pdfCompatible(info));
});

test('variantes que precisam ser recomprimidas', () => {
  assert.equal(pdfCompatible(parseJpeg(jpeg(sof(0xc3)))), false); // sem perdas
  assert.equal(pdfCompatible(parseJpeg(jpeg(sof(0xc9)))), false); // aritmético
  assert.equal(pdfCompatible(parseJpeg(jpeg(sof(0xc0, { precision: 12 })))), false);
  const cmyk = parseJpeg(jpeg(segment(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 2]), sof(0xc0, { components: 4 })));
  assert.equal(cmyk.components, 4);
  assert.deepEqual(cmyk.adobe, { transform: 2 });
  assert.equal(pdfCompatible(cmyk), false);
});

test('DHT (0xC4) e DAC (0xCC) não são confundidos com SOF', () => {
  const info = parseJpeg(jpeg(segment(0xc4, [0, 1, 2]), segment(0xcc, [1, 2]), sof(0xc2, { width: 9, height: 7 })));
  assert.equal(info.sof, 0xc2);
  assert.equal(info.width, 9);
});

function exifSegment(little, entries) {
  // TIFF com IFD0 logo depois do cabeçalho; valores RATIONAL ficam depois do IFD
  const u16 = (v) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const ifdStart = 8;
  const extraStart = ifdStart + 2 + entries.length * 12 + 4;
  const extra = [];
  const body = [];
  for (const e of entries) {
    if (e.type === 5) {
      body.push(...u16(e.tag), ...u16(5), ...u32(1), ...u32(extraStart + extra.length));
      extra.push(...u32(e.num), ...u32(e.den));
    } else {
      body.push(...u16(e.tag), ...u16(3), ...u32(1), ...u16(e.value), 0, 0);
    }
  }
  const tiff = [...ascii(little ? 'II' : 'MM'), ...u16(42), ...u32(ifdStart), ...u16(entries.length), ...body, 0, 0, 0, 0, ...extra];
  return [...ascii('Exif'), 0, 0, ...tiff];
}

test('EXIF em little endian e big endian, com resolução em centímetros', () => {
  const le = parseExif(new Uint8Array(exifSegment(true, [{ tag: 0x0112, value: 8 }])));
  assert.equal(le.orientation, 8);
  const be = parseExif(new Uint8Array(exifSegment(false, [
    { tag: 0x0112, value: 3 }, { tag: 0x011a, type: 5, num: 118, den: 1 }, { tag: 0x0128, value: 3 },
  ])));
  assert.equal(be.orientation, 3);
  assert.equal(be.xResolution, 118);
  const info = parseJpeg(jpeg(segment(0xe1, exifSegment(false, [
    { tag: 0x0112, value: 6 }, { tag: 0x011a, type: 5, num: 118, den: 1 }, { tag: 0x0128, value: 3 },
  ])), sof(0xc0)));
  assert.equal(info.orientation, 6);
  assert.equal(info.dpi, 299.72); // 118 pontos por cm
  assert.equal(parseExif(new Uint8Array([...ascii('Exif'), 0, 0, ...ascii('XX')])), null);
  // orientação fora de 1 a 8 é ignorada (0 = ausente; o JPEG fica com 1)
  assert.equal(parseExif(new Uint8Array(exifSegment(true, [{ tag: 0x0112, value: 9 }]))).orientation, 0);
  assert.equal(parseJpeg(jpeg(segment(0xe1, exifSegment(true, [{ tag: 0x0112, value: 9 }])), sof(0xc0))).orientation, 1);
});

test('erros: não é JPEG, arquivo cortado e sem SOF', () => {
  assert.equal(isJpeg(new Uint8Array([0x89, 0x50, 0x4e])), false);
  assert.throws(() => parseJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), ImageFormatError);
  assert.throws(() => parseJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x30, 1, 2])), /cortado/);
  assert.throws(() => parseJpeg(jpeg(segment(0xe0, [1, 2, 3]))), /sem segmento SOF/);
  assert.throws(() => parseJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 0, 0, 0, 3])), /dimensões inválidas/);
  assert.throws(() => parseJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0x12])), /marcador esperado/);
});
