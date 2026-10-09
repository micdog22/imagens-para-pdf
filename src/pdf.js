// Escritor de PDF feito à mão: catálogo, árvore de páginas, uma página por
// imagem com um XObject de imagem (bytes JPEG com o filtro DCTDecode), um
// fluxo de conteúdo que posiciona a imagem, tabela xref com os deslocamentos
// exatos de cada objeto, trailer e startxref.

const encoder = new TextEncoder();

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  text(str) {
    if (/[^\x00-\x7f]/.test(str)) throw new Error('A sintaxe do PDF aqui só usa ASCII.');
    this.bytes(encoder.encode(str));
  }
  bytes(u8) {
    this.chunks.push(u8);
    this.length += u8.length;
  }
  toUint8Array() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** Número no formato do PDF: sem notação científica, até 4 casas decimais. */
export function pdfNumber(n) {
  if (!Number.isFinite(n)) throw new RangeError('Número inválido no PDF.');
  const r = Math.round(n * 10000) / 10000;
  if (Object.is(r, -0) || r === 0) return '0';
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** Texto do PDF em UTF-16BE com marca de ordem de bytes, como string hexadecimal. */
export function pdfTextString(text) {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/** Data do PDF: D:AAAAMMDDHHmmSS seguido do fuso, por exemplo -03'00'. */
export function pdfDate(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `D:${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`;
}

const COLOR_SPACES = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' };

/**
 * Monta o PDF. pages: lista de { width, height, image, matrix }, em que
 * image = { data (JPEG), width, height, components, adobe } e matrix é a
 * matriz [a b c d e f] do operador cm. info: { title, date }.
 */
export function buildPdf(pages, info = {}) {
  if (!pages.length) throw new Error('O PDF precisa de pelo menos uma página.');
  const w = new ByteWriter();
  const offsets = [];
  // O comentário com bytes acima de 127 avisa a programas de transferência que o arquivo é binário.
  w.text('%PDF-1.4\n%');
  w.bytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]));
  w.text('\n');

  const begin = (num) => {
    offsets[num] = w.length;
    w.text(`${num} 0 obj\n`);
  };
  const end = () => w.text('endobj\n');

  const pageIds = pages.map((_, k) => 3 + k * 3);
  const infoId = 3 + pages.length * 3;

  begin(1);
  w.text('<< /Type /Catalog /Pages 2 0 R >>\n');
  end();
  begin(2);
  w.text(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\n`);
  end();

  pages.forEach((pg, k) => {
    const pageId = pageIds[k];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const { image } = pg;
    const colorSpace = COLOR_SPACES[image.components];
    if (!colorSpace) throw new Error(`Imagem com ${image.components} componentes não é suportada.`);

    begin(pageId);
    w.text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(pg.width)} ${pdfNumber(pg.height)}] ` +
      `/Resources << /XObject << /Im${k} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`);
    end();

    const content = encoder.encode(`q ${pg.matrix.map(pdfNumber).join(' ')} cm /Im${k} Do Q\n`);
    begin(contentId);
    w.text(`<< /Length ${content.length} >>\nstream\n`);
    w.bytes(content);
    w.text('endstream\n');
    end();

    // JPEG de 4 componentes com marcador Adobe guarda o CMYK invertido.
    const decode = image.components === 4 && image.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    begin(imageId);
    w.text(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${image.data.length} >>\nstream\n`);
    w.bytes(image.data);
    w.text('\nendstream\n');
    end();
  });

  begin(infoId);
  const date = pdfDate(info.date ?? new Date());
  const title = info.title ? ` /Title ${pdfTextString(info.title)}` : '';
  w.text(`<<${title} /Producer (Imagens para PDF) /CreationDate (${date}) >>\n`);
  end();

  const size = infoId + 1;
  const xrefOffset = w.length;
  w.text(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let num = 1; num < size; num++) {
    w.text(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`);
  }
  w.text(`trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return w.toUint8Array();
}

/**
 * Estimativa do tamanho final sem montar o arquivo: soma das imagens mais a
 * estrutura (cabeçalho, objetos, xref e trailer).
 */
export function estimatePdfSize(imageSizes) {
  const perPage = 360;
  return 400 + imageSizes.reduce((s, n) => s + n + perPage, 0);
}
