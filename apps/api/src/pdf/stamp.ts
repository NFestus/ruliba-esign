import { degrees, PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';

/**
 * Builds the signed copy: every filled field is drawn onto its page (images for signatures and
 * initials, text for the rest), then a "Signing record" page is added at the end.
 * Field positions are fractions of the page as the signer saw it on screen (rotation applied),
 * so they are mapped back to PDF coordinates for each of the four page rotations.
 */

export interface StampField {
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value?: string | null;
  image?: Buffer | null;
}

export interface RecordRow {
  label: string;
  value: string;
}

export interface SigningRecord {
  title: string;
  reference: string | null;
  documentId: string;
  preparedSha256: string;
  sender: string;
  sentAt: string;
  completedAt: string;
  people: { name: string; email: string; role: string; rows: RecordRow[] }[];
  footer: string;
}

const INK = rgb(0.09, 0.11, 0.2); // dark blue-black, reads as pen ink
const GREY = rgb(0.38, 0.4, 0.45);
const CLAY = rgb(0.75, 0.27, 0.13);

/** Standard PDF fonts only cover Western European characters; anything else becomes '?'. */
export function winAnsi(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/** Rectangle in PDF user space plus the rotation needed to draw upright as the signer saw it. */
export function mapRect(page: PDFPage, f: Pick<StampField, 'x' | 'y' | 'width' | 'height'>) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = rot % 180 === 0 ? box.width : box.height; // on-screen width
  const H = rot % 180 === 0 ? box.height : box.width;
  const u = f.x * W; // left, from screen top-left
  const v = f.y * H; // top
  const w = f.width * W;
  const h = f.height * H;
  // Anchor = the field's bottom-left corner as the signer saw it, in PDF space.
  switch (rot) {
    case 90:
      return { x: box.x + v + h, y: box.y + u, w, h, rotate: 90 };
    case 180:
      return { x: box.x + box.width - u, y: box.y + v + h, w, h, rotate: 180 };
    case 270:
      return { x: box.x + box.width - v - h, y: box.y + box.height - u, w, h, rotate: 270 };
    default:
      return { x: box.x + u, y: box.y + box.height - v - h, w, h, rotate: 0 };
  }
}

function fitText(font: PDFFont, text: string, maxW: number, maxH: number) {
  let size = Math.min(maxH * 0.72, 14);
  while (size > 5 && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return size;
}

export async function stampDocument(prepared: Buffer, fields: StampField[], record: SigningRecord): Promise<Buffer> {
  const pdf = await PDFDocument.load(prepared, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const r = mapRect(page, f);
    const angle = degrees(r.rotate);
    if ((f.type === 'SIGNATURE' || f.type === 'INITIALS' || f.type === 'STAMP') && f.image) {
      const img = await pdf.embedPng(f.image);
      // Keep the signature's proportions inside the box, aligned left and centred vertically.
      const scale = Math.min(r.w / img.width, r.h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const off = (r.h - dh) / 2;
      const o = offset(r.rotate, 0, off);
      page.drawImage(img, { x: r.x + o.dx, y: r.y + o.dy, width: dw, height: dh, rotate: angle });
    } else if (f.type === 'CHECKBOX') {
      if (f.value === 'true') {
        const size = fitText(bold, 'X', r.w, r.h);
        const o = offset(r.rotate, r.w * 0.2, r.h * 0.18);
        page.drawText('X', { x: r.x + o.dx, y: r.y + o.dy, size, font: bold, color: INK, rotate: angle });
      }
    } else if (f.value) {
      const text = winAnsi(f.value);
      const size = fitText(font, text, r.w, r.h);
      const o = offset(r.rotate, 1, (r.h - size) / 2 + size * 0.2);
      page.drawText(text, { x: r.x + o.dx, y: r.y + o.dy, size, font, color: INK, rotate: angle });
    }
  }

  addRecordPages(pdf, record, font, bold);
  pdf.setProducer('Ruliba Clays eSign');
  pdf.setModificationDate(new Date(record.completedAt));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** Stand-alone Certificate of Completion: the signing record on its own, for filing or sending separately. */
export async function certificatePdf(record: SigningRecord): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  addRecordPages(pdf, { ...record, title: `Certificate of completion: ${record.title}` }, font, bold);
  pdf.setTitle(`Certificate of completion - ${record.title}`);
  pdf.setProducer('Ruliba Clays eSign');
  pdf.setCreationDate(new Date(record.completedAt));
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** Moves a point by (along, up) in the field's own upright frame, for each page rotation. */
function offset(rot: number, along: number, up: number) {
  switch (rot) {
    case 90:
      return { dx: -up, dy: along };
    case 180:
      return { dx: -along, dy: -up };
    case 270:
      return { dx: up, dy: -along };
    default:
      return { dx: along, dy: up };
  }
}

function addRecordPages(pdf: PDFDocument, rec: SigningRecord, font: PDFFont, bold: PDFFont) {
  const A4: [number, number] = [595.28, 841.89];
  const M = 50;
  let page = pdf.addPage(A4);
  let y = A4[1] - M;

  const line = (text: string, opts: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.f ?? font;
    const maxW = A4[0] - 2 * M - (opts.indent ?? 0);
    // wrap on spaces
    const words = winAnsi(text).split(' ');
    let cur = '';
    const out: string[] = [];
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > maxW && cur) {
        out.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) out.push(cur);
    for (const l of out) {
      if (y < M + size) {
        page = pdf.addPage(A4);
        y = A4[1] - M;
      }
      page.drawText(l, { x: M + (opts.indent ?? 0), y: y - size, size, font: f, color: opts.color ?? INK });
      y -= size * 1.45;
    }
  };

  line('Signing record', { size: 20, f: bold });
  page.drawRectangle({ x: M, y: y - 4, width: 40, height: 3, color: CLAY });
  y -= 18;
  line(rec.title, { size: 12, f: bold });
  y -= 4;
  const meta: RecordRow[] = [
    { label: 'Reference', value: rec.reference ?? 'None' },
    { label: 'Document ID', value: rec.documentId },
    { label: 'Sent by', value: rec.sender },
    { label: 'Sent', value: rec.sentAt },
    { label: 'Completed', value: rec.completedAt },
    { label: 'Fingerprint of the document as sent (SHA-256)', value: rec.preparedSha256 },
  ];
  for (const m of meta) {
    line(m.label, { size: 8.5, color: GREY });
    line(m.value, { size: 10 });
    y -= 2;
  }
  y -= 10;
  for (const p of rec.people) {
    if (y < 200) {
      page = pdf.addPage(A4);
      y = A4[1] - M;
    }
    page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.6, color: rgb(0.85, 0.85, 0.85) });
    y -= 14;
    line(`${p.name}  <${p.email}>`, { size: 11, f: bold });
    line(p.role, { size: 9, color: GREY });
    for (const r of p.rows) line(`${r.label}: ${r.value}`, { size: 9, indent: 10 });
    y -= 8;
  }
  y -= 8;
  line(rec.footer, { size: 8.5, color: GREY });
}
