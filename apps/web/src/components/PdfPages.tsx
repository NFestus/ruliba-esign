import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ReactNode, useEffect, useRef, useState } from 'react';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageSize {
  width: number; // CSS pixels as shown
  height: number;
  scale: number; // CSS pixels per PDF point
}

/**
 * Shows every page of a PDF, fitted to the width of its container, with an overlay layer per page.
 * Field positions are fractions of the page as shown (rotation applied), which is exactly what the
 * server maps back when it stamps the signed copy.
 */
export function PdfPages({
  data,
  overlay,
  maxWidth = 860,
  onPagesReady,
}: {
  data: ArrayBuffer | null;
  overlay?: (page: number, size: PageSize) => ReactNode;
  maxWidth?: number;
  onPagesReady?: (count: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    // Copy: pdf.js takes ownership of the buffer it is given.
    const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), isEvalSupported: false, enableXfa: false });
    task.promise.then(
      (d) => {
        if (cancelled) return;
        setDoc(d);
        onPagesReady?.(d.numPages);
      },
      () => !cancelled && setError('This document could not be shown.'),
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.min(maxWidth, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  return (
    <div ref={wrap} className="pdf-pages">
      {error && <div className="alert alert-error">{error}</div>}
      {!doc && !error && <p className="muted pdf-loading">Opening the document…</p>}
      {doc && width > 0 && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} index={i + 1} width={width} overlay={overlay} />)}
    </div>
  );
}

function PdfPage({ doc, index, width, overlay }: { doc: pdfjs.PDFDocumentProxy; index: number; width: number; overlay?: (page: number, size: PageSize) => ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<PageSize | null>(null);

  useEffect(() => {
    let task: pdfjs.RenderTask | null = null;
    let cancelled = false;
    void doc.getPage(index).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      setSize({ width, height: (base.height * width) / base.width, scale });
      task = page.render({ canvasContext: c.getContext('2d')!, viewport });
      task.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, index, width]);

  return (
    <div className="pdf-page" style={size ? { width: size.width, height: size.height } : { width }} data-page={index} aria-label={`Page ${index}`}>
      <canvas ref={canvas} style={size ? { width: size.width, height: size.height } : undefined} />
      {size && overlay && <div className="pdf-overlay">{overlay(index, size)}</div>}
    </div>
  );
}
