import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib';

export interface PdfInfo {
  pageCount: number;
  pages: { width: number; height: number; rotation: number }[];
}

export class PdfRejected extends Error {}

const MAX_PAGES = 200;

/** Keys that run code, open other programs, or carry hidden files inside a PDF. */
const ACTIVE_KEYS = ['JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'SubmitForm', 'ImportData', 'GoToR', 'XFA'];

/**
 * Opens a PDF and refuses it if it is not a real PDF, is password-protected, is too long,
 * or contains scripts, launch actions or attached files. Every object is inspected,
 * including objects packed inside compressed object streams (pdf-lib unpacks them).
 */
export async function inspectPdf(data: Buffer): Promise<PdfInfo> {
  if (data.subarray(0, 1024).indexOf('%PDF-') === -1) throw new PdfRejected('This file is not a PDF.');
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    throw new PdfRejected('This PDF is damaged and cannot be opened. Export it again and upload the new copy.');
  }
  if (doc.isEncrypted) throw new PdfRejected('This PDF is password-protected. Remove the password, then upload it again.');
  const pageCount = doc.getPageCount();
  if (pageCount === 0) throw new PdfRejected('This PDF has no pages.');
  if (pageCount > MAX_PAGES) throw new PdfRejected(`This PDF has ${pageCount} pages. The limit is ${MAX_PAGES}.`);

  const found = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream || obj instanceof PDFRawStream ? obj.dict : null;
    if (!dict) continue;
    for (const key of ACTIVE_KEYS) {
      if (dict.has(PDFName.of(key))) found.add(key);
    }
    const s = dict.get(PDFName.of('S'));
    if (s instanceof PDFName && ['JavaScript', 'Launch', 'SubmitForm', 'ImportData'].includes(s.decodeText())) found.add(s.decodeText());
  }
  // Names tree in the catalog (document-level scripts and attachments)
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  if (names?.has(PDFName.of('JavaScript'))) found.add('JavaScript');
  if (names?.has(PDFName.of('EmbeddedFiles'))) found.add('EmbeddedFiles');
  if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.lookupMaybe(PDFName.of('XFA'), PDFArray)) found.add('XFA');

  if (found.size) {
    throw new PdfRejected(
      `This PDF contains ${[...found].some((k) => /JavaScript|JS/.test(k)) ? 'scripts' : 'active content or attached files'} and was refused for safety. Print it to a new PDF ("Microsoft Print to PDF") and upload that copy.`,
    );
  }

  return {
    pageCount,
    pages: doc.getPages().map((p) => {
      const box = p.getCropBox();
      return { width: box.width, height: box.height, rotation: ((p.getRotation().angle % 360) + 360) % 360 };
    }),
  };
}
