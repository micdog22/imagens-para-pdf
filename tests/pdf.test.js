import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPdf, pdfNumber, pdfTextString, pdfDate, estimatePdfSize } from '../src/pdf.js';
import { parseJpeg } from '../src/jpeg.js';
import { layoutPage } from '../src/page.js';
import { readPdf, streamOf } from './helpers/pdf-reader.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function pageFrom(name, opts = {}) {
  const data = fixture(name);
  const info = parseJpeg(data);
  const lay = layoutPage({ width: info.width, height: info.height, orientation: info.orientation, dpi: info.dpi }, opts);
  return {
    width: lay.page.width,
    height: lay.page.height,
    matrix: lay.matrix,
    image: { data, width: info.width, height: info.height, components: info.components, adobe: info.adobe },
  };
}

const date = new Date(2026, 9, 9, 14, 30, 5);

test('cabeçalho, comentário binário e final do arquivo', () => {
  const pdf = buildPdf([pageFrom('baseline-16x8.jpg')], { date });
  assert.equal(new TextDecoder('latin1').decode(pdf.subarray(0, 9)), '%PDF-1.4\n');
  assert.deepEqual([...pdf.subarray(9, 15)], [0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
  assert.match(new TextDecoder('latin1').decode(pdf.subarray(-6)), /%%EOF\n$/);
});

test('xref: cada deslocamento aponta para o seu objeto, /Size e startxref corretos', () => {
  const pages = ['baseline-16x8.jpg', 'progressivo-16x8.jpg', 'exif6-16x8.jpg', 'cinza-300dpi-8x8.jpg'].map((f) => pageFrom(f));
  const bytes = buildPdf(pages, { title: 'Fotos da viagem', date });
  const pdf = readPdf(bytes);
  // catálogo, árvore de páginas, 3 objetos por página e o Info
  const objectCount = 2 + 3 * pages.length + 1;
  assert.equal(pdf.entries.length, objectCount + 1);
  assert.deepEqual(pdf.entries[0], { offset: 0, gen: 65535, type: 'f' });
  assert.match(pdf.trailer, new RegExp(`/Size ${objectCount + 1} `));
  assert.match(pdf.trailer, /\/Root 1 0 R/);
  assert.match(pdf.trailer, new RegExp(`/Info ${objectCount} 0 R`));
  assert.equal(pdf.objects.size, objectCount);
  // os deslocamentos crescem e não se sobrepõem
  const offs = pdf.entries.slice(1).map((e) => e.offset);
  assert.deepEqual([...offs].sort((a, b) => a - b), offs);
});

test('catálogo, árvore de páginas e cada página com sua imagem', () => {
  const pages = [pageFrom('baseline-16x8.jpg'), pageFrom('cinza-300dpi-8x8.jpg')];
  const bytes = buildPdf(pages, { date });
  const pdf = readPdf(bytes);
  assert.match(pdf.objects.get(1).body, /<< \/Type \/Catalog \/Pages 2 0 R >>/);
  assert.match(pdf.objects.get(2).body, /\/Kids \[3 0 R 6 0 R\] \/Count 2/);
  assert.match(pdf.objects.get(3).body, /\/Type \/Page \/Parent 2 0 R \/MediaBox \[0 0 841.89 595.28\]/);
  assert.match(pdf.objects.get(3).body, /\/XObject << \/Im0 5 0 R >>.*\/Contents 4 0 R/);
  assert.match(pdf.objects.get(5).body, /\/Subtype \/Image \/Width 16 \/Height 8 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.match(pdf.objects.get(8).body, /\/ColorSpace \/DeviceGray/);
  // os bytes do JPEG vão intactos para dentro do fluxo
  assert.deepEqual(streamOf(pdf, bytes, 5), fixture('baseline-16x8.jpg'));
  assert.deepEqual(streamOf(pdf, bytes, 8), fixture('cinza-300dpi-8x8.jpg'));
  // fluxo de conteúdo: salva o estado, posiciona com cm, desenha e restaura
  const content = new TextDecoder().decode(streamOf(pdf, bytes, 4));
  assert.match(content, /^q [\d. -]+ cm \/Im0 Do Q\n$/);
});

test('Info: título em UTF-16 e data no formato do PDF', () => {
  const bytes = buildPdf([pageFrom('baseline-16x8.jpg')], { title: 'Ação', date });
  const pdf = readPdf(bytes);
  const info = pdf.objects.get(6).body;
  assert.match(info, /\/Title <FEFF004100E700E3006F>/);
  assert.match(info, /\/Producer \(Imagens para PDF\)/);
  assert.match(info, /\/CreationDate \(D:20261009143005[+-]\d\d'\d\d'\)/);
});

test('números, textos e datas do PDF', () => {
  assert.equal(pdfNumber(595.28), '595.28');
  assert.equal(pdfNumber(10), '10');
  assert.equal(pdfNumber(-0.00001), '0');
  assert.equal(pdfNumber(1 / 3), '0.3333');
  assert.equal(pdfNumber(-12.5), '-12.5');
  assert.equal(pdfNumber(1e-7), '0');
  assert.doesNotMatch(pdfNumber(123456789.123), /e/);
  assert.throws(() => pdfNumber(Infinity), RangeError);
  assert.equal(pdfTextString('A'), '<FEFF0041>');
  assert.equal(pdfTextString('😀'), '<FEFFD83DDE00>');
  assert.match(pdfDate(new Date(2026, 0, 2, 3, 4, 5)), /^D:20260102030405[+-]\d\d'\d\d'$/);
});

test('CMYK com marcador Adobe ganha /Decode invertido', () => {
  const page = pageFrom('baseline-16x8.jpg');
  page.image = { ...page.image, components: 4, adobe: { transform: 2 } };
  const bytes = buildPdf([page], { date });
  const body = readPdf(bytes).objects.get(5).body;
  assert.match(body, /\/ColorSpace \/DeviceCMYK .*\/Decode \[1 0 1 0 1 0 1 0\]/);
  page.image.components = 2;
  assert.throws(() => buildPdf([page]), /2 componentes/);
  assert.throws(() => buildPdf([]), /pelo menos uma página/);
});

test('estimativa de tamanho fica perto do real', () => {
  const names = ['baseline-16x8.jpg', 'progressivo-16x8.jpg', 'exif6-16x8.jpg', 'cinza-300dpi-8x8.jpg'];
  const pages = names.map((f) => pageFrom(f));
  const real = buildPdf(pages, { title: 'Estimativa', date }).length;
  const est = estimatePdfSize(names.map((f) => fixture(f).length));
  assert.ok(Math.abs(est - real) < 150 * names.length, `estimado ${est}, real ${real}`);
});
