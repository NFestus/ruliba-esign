import { PDFDocument, degrees } from 'pdf-lib';
import { mapRect, winAnsi } from './stamp';
import { inspectPdf, PdfRejected } from './inspect';

async function pageWithRotation(angle: number) {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([600, 800]); // portrait media box
  p.setRotation(degrees(angle));
  return p;
}

describe('field position mapping', () => {
  // A field in the top-left corner of what the signer saw (10% in, 10% down, 20% x 5% of the screen page)
  const f = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };

  it('unrotated page: top-left of the screen is top-left of the page', async () => {
    const r = mapRect(await pageWithRotation(0), f);
    expect(r).toMatchObject({ rotate: 0, w: 120, h: 40 });
    expect(r.x).toBeCloseTo(60);
    expect(r.y).toBeCloseTo(800 - 80 - 40);
  });

  it('page rotated 90: the screen is landscape (800 wide x 600 high)', async () => {
    const r = mapRect(await pageWithRotation(90), f);
    expect(r).toMatchObject({ rotate: 90, w: 160, h: 30 });
    // Screen top-left corner (u=80, v=60) lies at the PDF's bottom-left region: x = v + h, y = u
    expect(r.x).toBeCloseTo(90);
    expect(r.y).toBeCloseTo(80);
  });

  it('page rotated 180 and 270 stay inside the page', async () => {
    for (const a of [180, 270]) {
      const r = mapRect(await pageWithRotation(a), f);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x).toBeLessThanOrEqual(600);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeLessThanOrEqual(800);
    }
  });
});

describe('text for standard PDF fonts', () => {
  it('keeps French accents and replaces characters the font cannot draw', () => {
    expect(winAnsi('Société “Kigali” – Ltd')).toBe('Société "Kigali" - Ltd');
    expect(winAnsi('名前')).toBe('??');
  });
});

describe('PDF safety check', () => {
  it('accepts a plain PDF and reports its pages', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    pdf.addPage([842, 595]);
    const info = await inspectPdf(Buffer.from(await pdf.save()));
    expect(info.pageCount).toBe(2);
    expect(info.pages[1]).toMatchObject({ width: 842, height: 595, rotation: 0 });
  });

  it('refuses a PDF with an embedded script', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addJavaScript('hello', 'app.alert("hi")');
    await expect(inspectPdf(Buffer.from(await pdf.save()))).rejects.toThrow(/scripts/);
  });

  it('refuses a PDF with an attached file', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await pdf.attach(Buffer.from('MZ fake exe'), 'invoice.exe', { mimeType: 'application/octet-stream' });
    await expect(inspectPdf(Buffer.from(await pdf.save()))).rejects.toThrow(PdfRejected);
  });

  it('refuses something that is not a PDF', async () => {
    await expect(inspectPdf(Buffer.from('PK\x03\x04 zip file'))).rejects.toThrow(/not a PDF/);
  });
});
