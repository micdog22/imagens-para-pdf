# Imagens para PDF

Junte fotos e digitalizações JPEG, PNG e WebP em um PDF direto no navegador, sem enviar nada para servidor nenhum. O PDF é escrito à mão, byte a byte: os JPEGs entram no arquivo do jeito que estão (sem perder qualidade), a orientação EXIF das fotos de celular é respeitada e dá para recomprimir, reduzir e converter documentos para tons de cinza.

**Acesse online:** https://micdog22.github.io/imagens-para-pdf/

## Recursos

- **JPEG, PNG e WebP**, arrastando para a página ou escolhendo os arquivos.
- **Reordenar** arrastando as miniaturas ou com os botões (funcionam no teclado e no celular), **girar** de 90 em 90 graus, remover e ordenar por nome ("foto 2" antes de "foto 10").
- **Página A4** (595,28 x 841,89 pt), **Carta** (612 x 792 pt) ou **do tamanho da imagem**; orientação automática (imagem deitada ganha página deitada), retrato ou paisagem; margens de 0, 5, 10 ou 20 mm.
- **Sem perda quando possível:** JPEGs baseline e progressivos vão para o PDF sem recompressão.
- **Qualidade e tamanho:** recompressão JPEG com controle de qualidade, limite para o lado maior da imagem e opção de tons de cinza para documentos e recibos. O tamanho estimado do PDF aparece antes de gerar.
- **Fotos de celular em pé:** a orientação EXIF (as 8 variações, inclusive espelhadas) é aplicada no PDF, que por padrão ignora essa informação.
- **Digitalizações no tamanho certo:** no modo "Ajustar à imagem", uma folha digitalizada a 300 dpi vira uma página do tamanho de uma A4.
- **Privacidade:** tudo acontece no navegador; nenhuma imagem é enviada.

## Como usar

1. Arraste as imagens para a área indicada (ou clique em "Escolher imagens").
2. Arrume a ordem e a rotação de cada uma. O número na miniatura é a página.
3. Escolha o tamanho da página, a margem e a qualidade.
4. Clique em **Gerar PDF**. O arquivo é baixado e também pode ser aberto numa nova aba.

Dica para deixar o PDF pequeno: limite o lado maior a 1600 ou 2000 px. Uma foto de celular de 12 megapixels não precisa de toda essa resolução numa página A4.

Fotos HEIC (o formato padrão do iPhone) não são abertas pelos navegadores; exporte como JPEG antes, ou configure a câmera para "Mais compatível".

## Como rodar localmente

Não há build nem dependências. Sirva a pasta:

```bash
python3 -m http.server 8000
```

e abra http://localhost:8000.

## Testes

```bash
npm test
```

ou `node --test`. Os testes cobrem:

- a estrutura do PDF: um leitor escrito para os testes segue o `startxref`, confere que a tabela xref tem entradas de exatamente 20 bytes, que cada deslocamento aponta para o seu `N 0 obj`, que o `/Size` está certo e que o `/Length` de cada fluxo termina no `endstream`;
- os bytes do JPEG entrando intactos no PDF, o título em UTF-16 e o formato da data;
- a leitura de JPEGs reais (baseline, progressivo, com orientação EXIF, em tons de cinza e com 300 dpi) e de marcadores sintéticos (bytes de preenchimento, RST, DHT, SOF1, SOF3, CMYK com marcador Adobe, EXIF em little e big endian, arquivos cortados);
- a geometria: tamanhos A4 e Carta, orientação automática, encaixe e centralização, as 8 orientações EXIF e as rotações (cada canto da imagem vai para o lugar certo), e o limite de tamanho de página;
- as decisões de recompressão, a redução, os tons de cinza, a ordenação natural e a formatação de tamanhos.

Durante o desenvolvimento, os PDFs gerados também foram abertos pelo PDFKit do macOS (quantidade e tamanho das páginas) e renderizados, comparando as cores de cada quadrante com a imagem orientada pelo próprio sistema, nas 8 orientações EXIF e em todas as rotações.

## Como funciona

### O PDF por dentro

Um PDF é um arquivo de texto com partes binárias: uma sequência de **objetos** numerados, uma **tabela xref** que diz em que byte cada objeto começa e um **trailer** que aponta para a raiz. Este é o PDF gerado para uma foto de celular numa página A4 (só os bytes da imagem foram omitidos):

```
%PDF-1.4
%âãÏÓ
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 56 >>
stream
q 0 -785.1971 392.5985 0 101.3407 813.5435 cm /Im0 Do Q
endstream
endobj
5 0 obj
<< /Type /XObject /Subtype /Image /Width 16 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 893 >>
stream
(bytes do JPEG)
endstream
endobj
6 0 obj
<< /Title <FEFF0046006F0074006F0073> /Producer (Imagens para PDF) /CreationDate (D:20261009100000-03'00') >>
endobj
xref
0 7
0000000000 65535 f 
0000000015 00000 n 
0000000064 00000 n 
...
trailer
<< /Size 7 /Root 1 0 R /Info 6 0 R >>
startxref
1543
%%EOF
```

- O **catálogo** (objeto 1) aponta para a **árvore de páginas** (objeto 2), que lista as páginas.
- Cada **página** tem um `MediaBox` (o tamanho, em pontos de 1/72 de polegada), os recursos que usa (aqui a imagem `/Im0`) e um **fluxo de conteúdo** com os comandos de desenho.
- O conteúdo `q ... cm /Im0 Do Q` salva o estado gráfico, aplica uma matriz de transformação (`cm`), desenha a imagem e restaura o estado.
- A **imagem** é um XObject com o filtro `/DCTDecode`, que é o próprio formato JPEG. Por isso os bytes do arquivo original entram como estão: o leitor de PDF decodifica o JPEG na hora de mostrar.
- A **xref** tem uma linha de exatamente 20 bytes por objeto, com o deslocamento em 10 dígitos. O `startxref` no fim diz onde a xref começa. É por isso que leitores de PDF começam pelo final do arquivo.
- A segunda linha, com bytes acima de 127, avisa programas de transferência de que o arquivo é binário.

### O que é lido do JPEG

Não é preciso decodificar a imagem, só percorrer os **marcadores**: cada segmento começa com `FF xx` e um comprimento de 2 bytes. O segmento **SOF** (`FF C0` no baseline, `FF C2` no progressivo) traz altura, largura e número de componentes (1 para tons de cinza, 3 para cor); o **APP1 EXIF** traz a orientação; o **APP0 JFIF** ou o próprio EXIF trazem a resolução. Variantes raras (sem perdas, aritmético, 12 bits) e JPEGs CMYK passam pelo navegador e são recomprimidas.

### Orientação EXIF

O celular grava a foto sempre na posição do sensor e anota no EXIF como ela deve ser mostrada: 1 é normal, 3 é girada 180 graus, 6 e 8 são 90 graus para um lado ou outro, e 2, 4, 5 e 7 são as versões espelhadas. Navegadores e visualizadores de fotos aplicam isso; **o PDF não**, então uma foto em pé apareceria deitada.

A solução está na matriz do operador `cm`. Uma imagem no PDF é desenhada no quadrado unitário (de 0 a 1 nos dois eixos), com a primeira linha de pixels em cima. Cada orientação é uma simetria desse quadrado: girar 90 graus no sentido horário leva o ponto (x, y) para (y, 1 - x), espelhar leva (x, y) para (1 - x, y), e assim por diante. O programa compõe três transformações, nesta ordem:

1. a simetria da orientação EXIF;
2. a rotação escolhida na miniatura (0, 90, 180 ou 270 graus);
3. a escala e a posição do retângulo na página.

No exemplo acima, a foto tem orientação 6 (gravada deitada, 16 x 8 pixels) e a matriz `0 -785.1971 392.5985 0 101.3407 813.5435` faz as três coisas de uma vez: os zeros na diagonal são o giro de 90 graus, os outros dois números são a altura e a largura na página e os dois últimos, a posição.

### Encaixe e centralização

A área útil é a página menos as margens. A escala é o menor entre `largura útil / largura da imagem` e `altura útil / altura da imagem` (assim a imagem cabe inteira, sem distorcer) e a sobra é dividida igualmente dos dois lados. Com "Não ampliar imagens pequenas", a escala nunca passa de 1. Na orientação automática, a página fica deitada quando a imagem (já orientada e girada) é mais larga que alta.

O tamanho natural de uma imagem em pontos é `pixels x 72 / dpi`. Fotos costumam vir marcadas com 72 dpi, o que não significa nada físico, então o programa usa 96 dpi, a não ser que o arquivo diga 150 dpi ou mais, o caso típico de digitalizações: assim uma folha A4 digitalizada a 300 dpi (2480 x 3508 pixels) vira exatamente uma página A4.

### Recompressão no canvas

Quando é preciso recomprimir (PNG, WebP, tons de cinza, redução ou qualidade escolhida), a imagem é desenhada num `canvas` sobre fundo branco (a transparência do PNG vira branco, como no papel) e exportada com `toBlob("image/jpeg", qualidade)`. Para os tons de cinza, cada pixel vira `0,299 R + 0,587 G + 0,114 B`, os pesos da luminância da recomendação BT.601, os mesmos usados dentro do JPEG.

Os navegadores atuais já desenham as fotos em pé no canvas, aplicando o EXIF. Para ter certeza, o programa monta na hora um JPEG de 2 x 1 pixel com orientação 6 e confere se o navegador o mostra como 1 x 2. Se não mostrar, a orientação é aplicada pela matriz do PDF também nas imagens recomprimidas.

### Estrutura do código

- `src/pdf.js`: o escritor de PDF;
- `src/jpeg.js`: leitura dos marcadores do JPEG (e da densidade do PNG);
- `src/page.js`: tamanhos de página, encaixe e as matrizes de orientação;
- `src/images.js`: decisões de recompressão, redução, tons de cinza e utilidades;
- `src/app.js`: a interface.

## Contribuindo

Issues e pull requests são bem-vindos.

## Licença

MIT. Veja [LICENSE](LICENSE).
