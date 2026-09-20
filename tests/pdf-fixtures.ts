// Minimal synthetic PDF documents, generated in memory without private files or network access.
export function pdfFixture(options: { text?: string; pages?: number; jpeg?: Uint8Array; link?: string } = {}): Buffer {
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.alloc(0),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  const add = (value: string | Buffer) => { objects.push(typeof value === 'string' ? Buffer.from(value) : value); return objects.length; };
  const stream = (data: Buffer, fields = '') => Buffer.concat([Buffer.from(`<< ${fields} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  const escaped = (text: string) => text.replace(/[\\()]/g, '\\$&');
  const image = options.jpeg ? add(stream(Buffer.from(options.jpeg), '/Type /XObject /Subtype /Image /Width 600 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')) : undefined;
  const annotation = options.link ? add(`<< /Type /Annot /Subtype /Link /Rect [20 20 200 50] /A << /S /URI /URI (${escaped(options.link)}) >> >>`) : undefined;
  const kids: number[] = [];
  for (let index = 0; index < (options.pages ?? 1); index++) {
    const commands = image ? 'q 600 0 0 300 0 0 cm /Im1 Do Q' : `BT /F1 16 Tf 20 250 Td (${escaped(options.text ?? 'Recruitment fair: 2026-09-24 14:30 Hall 201. Please bring your resume.')}) Tj ET`;
    const contents = add(stream(Buffer.from(commands)));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im1 ${image} 0 R >>` : ''} >> /Contents ${contents} 0 R ${annotation ? `/Annots [${annotation} 0 R]` : ''} >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] >>`);
  const parts = [Buffer.from('%PDF-1.4\n')], offsets: number[] = [];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}
