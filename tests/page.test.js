import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pg from '../src/page.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('tamanhos de página em pontos', () => {
  assert.deepEqual(pg.PAGE_SIZES.a4, { label: 'A4', width: 595.28, height: 841.89 });
  assert.deepEqual(pg.PAGE_SIZES.letter, { label: 'Carta', width: 612, height: 792 });
  assert.ok(close(210 * pg.MM, 595.2756, 1e-3), 'A4 tem 210 mm de largura');
  assert.ok(close(297 * pg.MM, 841.8898, 1e-3));
});

test('orientação automática acompanha a imagem; retrato e paisagem forçam', () => {
  const wide = { width: 400, height: 300 };
  const tall = { width: 300, height: 400 };
  assert.deepEqual(pg.pageSize('a4', 'auto', wide), { width: 841.89, height: 595.28 });
  assert.deepEqual(pg.pageSize('a4', 'auto', tall), { width: 595.28, height: 841.89 });
  assert.deepEqual(pg.pageSize('letter', 'portrait', wide), { width: 612, height: 792 });
  assert.deepEqual(pg.pageSize('letter', 'landscape', tall), { width: 792, height: 612 });
  assert.throws(() => pg.pageSize('a3', 'auto', wide), RangeError);
});

test('encaixe centralizado com margens', () => {
  // foto 4:3 em A4 retrato com 10 mm de margem: a largura limita
  const page = { width: 595.28, height: 841.89 };
  const m = 10 * pg.MM;
  const r = pg.fitAndCenter(page, m, { width: 3000, height: 2250 });
  assert.ok(close(r.width, 595.28 - 2 * m));
  assert.ok(close(r.height, r.width * 0.75));
  assert.ok(close(r.x, m));
  assert.ok(close(r.y, (841.89 - r.height) / 2), 'centralizada na vertical');
  // imagem alta: a altura limita e a sobra horizontal se divide igualmente
  const t = pg.fitAndCenter(page, 0, { width: 100, height: 1000 });
  assert.ok(close(t.height, 841.89));
  assert.ok(close(t.x * 2 + t.width, 595.28));
  // sem ampliar: imagem pequena fica no tamanho natural, no centro
  const small = pg.fitAndCenter(page, m, { width: 100, height: 50 }, { upscale: false });
  assert.equal(small.width, 100);
  assert.ok(close(small.x, (595.28 - 100) / 2));
  assert.throws(() => pg.fitAndCenter(page, 300, { width: 1, height: 1 }), /margem é grande demais/);
});

test('resolução: usa a do arquivo só para digitalizações', () => {
  assert.equal(pg.effectiveDpi(0), 96);
  assert.equal(pg.effectiveDpi(72), 96);
  assert.equal(pg.effectiveDpi(300), 300);
  assert.deepEqual(pg.naturalSizePt(960, 480, 96), { width: 720, height: 360 });
  // folha A4 digitalizada a 300 dpi vira uma página do tamanho de uma A4
  const lay = pg.layoutPage({ width: 2480, height: 3508, dpi: 300 }, { size: 'fit', marginMm: 0 });
  assert.ok(close(lay.page.width, 595.2, 1e-9));
  assert.ok(close(lay.page.height, 841.92, 1e-9));
});

test('modo ajustar: margem em volta e limite de 14400 pt', () => {
  const lay = pg.layoutPage({ width: 960, height: 480 }, { size: 'fit', marginMm: 10 });
  const m = 10 * pg.MM;
  assert.ok(close(lay.page.width, 720 + 2 * m));
  assert.ok(close(lay.rect.x, m));
  assert.ok(close(lay.rect.width, 720));
  const huge = pg.layoutPage({ width: 40000, height: 1000 }, { size: 'fit', marginMm: 5 });
  assert.ok(close(huge.page.width, pg.MAX_PAGE_PT, 1e-6));
  assert.ok(huge.rect.width < huge.page.width);
  assert.ok(close(huge.rect.x * 2 + huge.rect.width, huge.page.width));
});

test('composição de matrizes e aplicação em pontos', () => {
  const t = [1, 0, 0, 1, 10, 20];
  const s = [2, 0, 0, 3, 0, 0];
  assert.deepEqual(pg.apply(pg.compose(s, t), 1, 1), [12, 23]);
  assert.deepEqual(pg.apply(pg.compose(t, s), 1, 1), [22, 63]);
  assert.deepEqual(pg.compose(pg.IDENTITY, s), s);
});

// Onde vão parar os cantos da imagem gravada (sup. esquerdo e sup. direito)
// depois de aplicar cada orientação EXIF, no quadrado unitário com y para cima.
const TL = [0, 1];
const TR = [1, 1];
const BL = [0, 0];
const BR = [1, 0];
const EXPECTED = {
  1: [TL, TR], 2: [TR, TL], 3: [BR, BL], 4: [BL, BR],
  5: [TL, BL], 6: [TR, BR], 7: [BR, TR], 8: [BL, TL],
};

test('as 8 orientações EXIF levam os cantos ao lugar certo', () => {
  for (let o = 1; o <= 8; o++) {
    const m = pg.exifMatrix(o);
    assert.deepEqual(pg.apply(m, 0, 1).map(Math.abs), EXPECTED[o][0], `orientação ${o}, canto superior esquerdo`);
    assert.deepEqual(pg.apply(m, 1, 1).map(Math.abs), EXPECTED[o][1], `orientação ${o}, canto superior direito`);
    assert.equal(pg.swapsAxes(m), o >= 5, `orientação ${o} troca os eixos?`);
  }
});

test('rotação da pessoa no sentido horário e combinação com EXIF', () => {
  assert.deepEqual(pg.apply(pg.rotationMatrix(90), 0, 1).map(Math.abs), TR);
  assert.deepEqual(pg.apply(pg.rotationMatrix(180), 0, 1).map(Math.abs), BR);
  assert.deepEqual(pg.apply(pg.rotationMatrix(270), 0, 1).map(Math.abs), BL);
  assert.deepEqual(pg.rotationMatrix(-90), pg.rotationMatrix(270));
  assert.deepEqual(pg.rotationMatrix(360), pg.IDENTITY);
  // EXIF 6 (gira 90) mais 270 da pessoa volta à posição gravada
  const back = pg.compose(pg.exifMatrix(6), pg.rotationMatrix(270));
  assert.deepEqual(pg.apply(back, 0, 1).map(Math.abs), TL);
  assert.deepEqual(pg.displayedPixels(4000, 3000, 6, 0), { width: 3000, height: 4000 });
  assert.deepEqual(pg.displayedPixels(4000, 3000, 6, 90), { width: 4000, height: 3000 });
  assert.deepEqual(pg.displayedPixels(4000, 3000, 1, 270), { width: 3000, height: 4000 });
});

test('matriz final: o quadrado unitário cobre exatamente o retângulo na página', () => {
  const rect = { x: 50, y: 70, width: 300, height: 200 };
  for (let o = 1; o <= 8; o++) {
    for (const rot of [0, 90, 180, 270]) {
      const m = pg.placementMatrix(o, rot, rect);
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => pg.apply(m, x, y).map((v) => Math.round(v * 1e6) / 1e6));
      const xs = corners.map((c) => c[0]).sort((a, b) => a - b);
      const ys = corners.map((c) => c[1]).sort((a, b) => a - b);
      assert.deepEqual([xs[0], xs[3], ys[0], ys[3]], [50, 350, 70, 270], `orientação ${o}, rotação ${rot}`);
    }
  }
});

test('layoutPage: foto de celular em pé (EXIF 6) numa A4 automática', () => {
  const lay = pg.layoutPage({ width: 4032, height: 3024, orientation: 6 }, { size: 'a4', orientation: 'auto', marginMm: 10 });
  assert.deepEqual(lay.page, { width: 595.28, height: 841.89 }, 'a imagem aparece em pé, então a página é retrato');
  assert.ok(close(lay.rect.width / lay.rect.height, 3024 / 4032));
  const [a, b, c, d] = lay.matrix;
  assert.equal(a, 0);
  assert.equal(d, 0);
  assert.ok(close(Math.abs(b), lay.rect.height) && close(Math.abs(c), lay.rect.width));
});
