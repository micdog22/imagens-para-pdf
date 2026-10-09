// Leitor mínimo de PDF para os testes: segue o startxref, lê a tabela xref e
// confere que cada deslocamento aponta exatamente para "N 0 obj".

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

export function readPdf(bytes) {
  const text = latin1(bytes);
  const tail = text.slice(-64);
  const m = /startxref\n(\d+)\n%%EOF\n$/.exec(tail);
  if (!m) throw new Error('final do arquivo sem startxref/%%EOF');
  const xrefAt = Number(m[1]);
  if (text.slice(xrefAt, xrefAt + 5) !== 'xref\n') throw new Error('startxref não aponta para a tabela xref');
  const header = /^xref\n0 (\d+)\n/.exec(text.slice(xrefAt));
  const count = Number(header[1]);
  const entriesStart = xrefAt + header[0].length;
  const entries = [];
  for (let k = 0; k < count; k++) {
    const line = text.slice(entriesStart + k * 20, entriesStart + (k + 1) * 20);
    const e = /^(\d{10}) (\d{5}) ([nf]) \n$/.exec(line);
    if (!e) throw new Error(`entrada ${k} da xref não tem 20 bytes no formato certo: ${JSON.stringify(line)}`);
    entries.push({ offset: Number(e[1]), gen: Number(e[2]), type: e[3] });
  }
  const trailerText = text.slice(entriesStart + count * 20);
  const trailer = /^trailer\n<<(.*?)>>\nstartxref\n/s.exec(trailerText);
  if (!trailer) throw new Error('trailer ausente logo depois da xref');
  const objects = new Map();
  entries.forEach((e, num) => {
    if (e.type !== 'n') return;
    const head = `${num} 0 obj\n`;
    if (text.slice(e.offset, e.offset + head.length) !== head) {
      throw new Error(`o deslocamento do objeto ${num} não aponta para "${num} 0 obj"`);
    }
    const endAt = text.indexOf('endobj\n', e.offset);
    objects.set(num, { offset: e.offset, body: text.slice(e.offset + head.length, endAt), start: e.offset + head.length });
  });
  return { text, entries, trailer: trailer[1], objects, xrefAt };
}

/** Extrai o fluxo de um objeto e confere o /Length com os bytes reais. */
export function streamOf(pdf, bytes, num) {
  const obj = pdf.objects.get(num);
  const len = Number(/\/Length (\d+)/.exec(obj.body)[1]);
  const start = obj.start + obj.body.indexOf('stream\n') + 'stream\n'.length;
  const after = pdf.text.slice(start + len, start + len + 10);
  if (!/^\n?endstream/.test(after)) throw new Error(`o /Length do objeto ${num} não termina no endstream`);
  return bytes.subarray(start, start + len);
}
