import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsReencode, fitWithin, toGrayscale, sortByName, moveItem, formatBytes, sniffType, pdfFileName } from '../src/images.js';
import { parseJpeg, insertExifOrientation, pngSize } from '../src/jpeg.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test('quando recomprimir', () => {
  const jpeg = { jpeg: parseJpeg(fixture('baseline-16x8.jpg')) };
  assert.equal(needsReencode(jpeg, {}), false, 'JPEG compatível vai como está');
  assert.equal(needsReencode(jpeg, { keepOriginals: false }), true);
  assert.equal(needsReencode(jpeg, { grayscale: true }), true);
  assert.equal(needsReencode(jpeg, { maxSide: 8 }), true, 'maior que o limite');
  assert.equal(needsReencode(jpeg, { maxSide: 16 }), false, 'no limite');
  assert.equal(needsReencode({ jpeg: null }, {}), true, 'PNG e WebP sempre');
  const cmyk = { jpeg: { ...jpeg.jpeg, components: 4 } };
  assert.equal(needsReencode(cmyk, {}), true, 'CMYK passa pelo navegador');
});

test('redução pelo lado maior mantém a proporção', () => {
  assert.deepEqual(fitWithin(4000, 3000, 0), { width: 4000, height: 3000 });
  assert.deepEqual(fitWithin(4000, 3000, 2000), { width: 2000, height: 1500 });
  assert.deepEqual(fitWithin(3000, 4000, 1200), { width: 900, height: 1200 });
  assert.deepEqual(fitWithin(800, 600, 1200), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 3, 100), { width: 100, height: 1 }, 'nunca zero');
});

test('tons de cinza com os pesos BT.601', () => {
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 128]);
  toGrayscale(px);
  assert.deepEqual([...px], [76, 76, 76, 255, 150, 150, 150, 255, 29, 29, 29, 255, 18, 18, 18, 128]);
});

test('ordenação natural por nome e movimentação', () => {
  const names = ['foto 10.jpg', 'Foto 2.jpg', 'foto 1.jpg', 'ábaco.png', 'zebra.webp'];
  assert.deepEqual(sortByName(names.map((name) => ({ name }))).map((i) => i.name),
    ['ábaco.png', 'foto 1.jpg', 'Foto 2.jpg', 'foto 10.jpg', 'zebra.webp']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
});

test('tamanhos de arquivo em português', () => {
  assert.equal(formatBytes(1), '1 byte');
  assert.equal(formatBytes(980), '980 bytes');
  assert.equal(formatBytes(1536), '1,50 KB');
  assert.equal(formatBytes(12.34 * 1024), '12,3 KB');
  assert.equal(formatBytes(4.567 * 1024 * 1024), '4,57 MB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
});

test('tipo pelo conteúdo e nome do PDF', () => {
  assert.equal(sniffType(fixture('baseline-16x8.jpg')), 'jpeg');
  assert.equal(sniffType(fixture('png-300dpi-4x4.png')), 'png');
  assert.equal(sniffType(new Uint8Array([...'RIFF\0\0\0\0WEBPVP8 '].map((c) => c.charCodeAt(0)))), 'webp');
  assert.equal(sniffType(new TextEncoder().encode('ftypheic texto')), null);
  assert.equal(pdfFileName('Relatório: março/2026'), 'Relatório- março-2026.pdf');
  assert.equal(pdfFileName('fotos.PDF'), 'fotos.pdf');
  assert.equal(pdfFileName('   '), 'imagens.pdf');
});

test('EXIF inserido num JPEG é lido de volta', () => {
  const original = fixture('cinza-300dpi-8x8.jpg');
  for (const o of [3, 6, 8]) {
    const out = insertExifOrientation(original, o);
    assert.equal(out.length, original.length + 36);
    const info = parseJpeg(out);
    assert.equal(info.orientation, o);
    assert.equal(info.width, 8);
    assert.equal(info.dpi, 300, 'o APP0 JFIF continua antes do EXIF');
  }
  assert.throws(() => insertExifOrientation(new Uint8Array([1, 2, 3]), 6), /não é um JPEG/);
});

test('dimensões de PNG pelo IHDR', () => {
  assert.deepEqual(pngSize(fixture('png-300dpi-4x4.png')), { width: 4, height: 4 });
  assert.equal(pngSize(fixture('baseline-16x8.jpg')), null);
});
