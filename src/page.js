// Geometria das páginas: tamanhos, orientação, margens, encaixe centralizado
// e as matrizes que aplicam a orientação EXIF e a rotação escolhida.
// Unidade: ponto tipográfico do PDF (1/72 de polegada).

export const MM = 72 / 25.4;
export const MAX_PAGE_PT = 14400; // limite prático de página no PDF (200 polegadas)

export const PAGE_SIZES = {
  a4: { label: 'A4', width: 595.28, height: 841.89 },
  letter: { label: 'Carta', width: 612, height: 792 },
};

/**
 * Resolução usada para converter pixels em pontos: a gravada no arquivo
 * quando é de 150 dpi ou mais (típico de digitalizações), senão 96 dpi.
 */
export function effectiveDpi(fileDpi) {
  return fileDpi >= 150 && fileDpi <= 2400 ? fileDpi : 96;
}

/** Tamanho natural da imagem em pontos, já com a orientação aplicada. */
export function naturalSizePt(pixelWidth, pixelHeight, dpi) {
  const k = 72 / dpi;
  return { width: pixelWidth * k, height: pixelHeight * k };
}

/**
 * Tamanho da página. size: 'a4', 'letter' ou 'fit'; orientation: 'auto',
 * 'portrait' ou 'landscape'. No modo automático, imagem deitada ganha página deitada.
 * Em 'fit' (ajustar à imagem), a página é a imagem no tamanho natural mais as margens.
 */
export function pageSize(size, orientation, image, marginPt = 0) {
  if (size === 'fit') {
    let width = image.width + 2 * marginPt;
    let height = image.height + 2 * marginPt;
    const scale = Math.min(1, MAX_PAGE_PT / Math.max(width, height));
    width *= scale;
    height *= scale;
    return { width, height };
  }
  const base = PAGE_SIZES[size];
  if (!base) throw new RangeError(`Tamanho de página desconhecido: ${size}`);
  const landscape = orientation === 'landscape' || (orientation === 'auto' && image.width > image.height);
  return landscape ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
}

/**
 * Encaixa um retângulo de tamanho (w, h) na área útil da página, mantendo a
 * proporção e centralizando. Com upscale = false, imagens menores que a área
 * ficam no tamanho natural em vez de ampliadas.
 */
export function fitAndCenter(page, marginPt, image, { upscale = true } = {}) {
  const availW = page.width - 2 * marginPt;
  const availH = page.height - 2 * marginPt;
  if (availW <= 0 || availH <= 0) throw new RangeError('A margem é grande demais para o tamanho da página.');
  let scale = Math.min(availW / image.width, availH / image.height);
  if (!upscale) scale = Math.min(scale, 1);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: marginPt + (availW - width) / 2, y: marginPt + (availH - height) / 2, width, height, scale };
}

// ---------------------------------------------------------------------------
// Matrizes [a b c d e f]: (x, y) vira (a x + c y + e, b x + d y + f), como no PDF.

export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Aplica m1 e depois m2. */
export function compose(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// Simetrias do quadrado unitário (y para cima, como no PDF). A imagem é
// desenhada no quadrado unitário com a primeira linha de pixels em cima.
const MIRROR_H = [-1, 0, 0, 1, 1, 0];
const MIRROR_V = [1, 0, 0, -1, 0, 1];
const ROT_90 = [0, -1, 1, 0, 0, 1]; // 90 graus no sentido horário
const ROT_180 = [-1, 0, 0, -1, 1, 1];
const ROT_270 = [0, 1, -1, 0, 1, 0];

/** Transformação que deixa a imagem em pé, para cada orientação EXIF de 1 a 8. */
export function exifMatrix(orientation) {
  switch (orientation) {
    case 2: return MIRROR_H;
    case 3: return ROT_180;
    case 4: return MIRROR_V;
    case 5: return compose(MIRROR_H, ROT_270); // espelha e gira 270 (transposta)
    case 6: return ROT_90;
    case 7: return compose(MIRROR_H, ROT_90); // espelha e gira 90 (transversa)
    case 8: return ROT_270;
    default: return IDENTITY;
  }
}

/** Rotação escolhida pela pessoa, em graus no sentido horário (0, 90, 180 ou 270). */
export function rotationMatrix(degrees) {
  switch (((degrees % 360) + 360) % 360) {
    case 90: return ROT_90;
    case 180: return ROT_180;
    case 270: return ROT_270;
    default: return IDENTITY;
  }
}

/** Diz se a transformação troca largura e altura (giros de 90 ou 270, transposições). */
export function swapsAxes(m) {
  return m[0] === 0;
}

/**
 * Matriz final do operador cm: orientação EXIF, depois a rotação da pessoa,
 * depois a escala e a posição do retângulo na página.
 */
export function placementMatrix(orientation, rotation, rect) {
  const s = compose(exifMatrix(orientation), rotationMatrix(rotation));
  return compose(s, [rect.width, 0, 0, rect.height, rect.x, rect.y]);
}

/** Dimensões (em pixels) da imagem como ela aparece, depois da orientação e da rotação. */
export function displayedPixels(pixelWidth, pixelHeight, orientation, rotation) {
  const s = compose(exifMatrix(orientation), rotationMatrix(rotation));
  return swapsAxes(s) ? { width: pixelHeight, height: pixelWidth } : { width: pixelWidth, height: pixelHeight };
}

/**
 * Monta tudo para uma página: tamanho da página, retângulo da imagem e a
 * matriz. image: { width, height } em pixels como gravados, orientation e
 * dpi (o do arquivo) ou exactDpi (já decidido, por exemplo depois de reduzir).
 */
export function layoutPage(image, { size = 'a4', orientation = 'auto', marginMm = 10, rotation = 0, upscale = true } = {}) {
  const shown = displayedPixels(image.width, image.height, image.orientation ?? 1, rotation);
  const dpi = image.exactDpi > 0 ? image.exactDpi : effectiveDpi(image.dpi ?? 0);
  const natural = naturalSizePt(shown.width, shown.height, dpi);
  const marginPt = marginMm * MM;
  const page = pageSize(size, orientation, natural, marginPt);
  let rect;
  if (size === 'fit') {
    // k é 1, ou menor quando a página passou do limite e foi reduzida junto com a margem
    const k = page.width / (natural.width + 2 * marginPt);
    rect = fitAndCenter(page, marginPt * k, natural);
  } else {
    rect = fitAndCenter(page, marginPt, natural, { upscale });
  }
  return { page, rect, matrix: placementMatrix(image.orientation ?? 1, rotation, rect) };
}
