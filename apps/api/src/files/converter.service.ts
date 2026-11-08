import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppConfig, CONFIG } from '../config';

const run = promisify(execFile);

/**
 * Word to PDF. Production: Gotenberg (LibreOffice in its own container, no network, JavaScript off).
 * Development: the local LibreOffice (soffice). The PDF is what people sign; the Word original is kept
 * with its own fingerprint.
 */
@Injectable()
export class ConverterService {
  constructor(@Inject(CONFIG) private readonly config: Pick<AppConfig, 'CONVERTER' | 'GOTENBERG_URL'>) {}

  async wordToPdf(data: Buffer, fileName: string): Promise<Buffer> {
    const ext = path.extname(fileName).toLowerCase() === '.doc' ? '.doc' : '.docx';
    switch (this.config.CONVERTER) {
      case 'gotenberg':
        return this.gotenberg(data, `document${ext}`);
      case 'soffice':
        return this.soffice(data, ext);
      default:
        throw new BadRequestException('Word files cannot be converted on this server. Save the document as PDF and upload that.');
    }
  }

  private async gotenberg(data: Buffer, name: string): Promise<Buffer> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(data)]), name);
    const res = await fetch(`${this.config.GOTENBERG_URL}/forms/libreoffice/convert`, { method: 'POST', body: form, signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new BadRequestException('This Word file could not be turned into PDF. Save it as PDF from Word and upload that.');
    return Buffer.from(await res.arrayBuffer());
  }

  private async soffice(data: Buffer, ext: string): Promise<Buffer> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'esign-conv-'));
    try {
      const input = path.join(dir, `document${ext}`);
      await writeFile(input, data);
      await run('soffice', ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, input], {
        timeout: 90_000,
      });
      return await readFile(path.join(dir, 'document.pdf'));
    } catch {
      throw new BadRequestException('This Word file could not be turned into PDF. Save it as PDF from Word and upload that.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
