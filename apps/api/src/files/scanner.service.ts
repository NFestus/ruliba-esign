import { Inject, Injectable, Logger } from '@nestjs/common';
import net from 'node:net';
import { AppConfig, CONFIG } from '../config';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'skipped'; reason: string };

/**
 * Virus scan through clamd's INSTREAM command (ClamAV container in production).
 * Production refuses to start without CLAMAV_HOST (see config.ts); in development and tests
 * the scan is skipped and that fact is written to the audit log with the upload.
 */
@Injectable()
export class ScannerService {
  private readonly log = new Logger('Scanner');

  constructor(@Inject(CONFIG) private readonly config: Pick<AppConfig, 'CLAMAV_HOST' | 'CLAMAV_PORT'>) {}

  async scan(data: Buffer): Promise<ScanResult> {
    if (!this.config.CLAMAV_HOST) return { status: 'skipped', reason: 'no virus scanner configured (development)' };
    const reply = await this.instream(data);
    if (/: OK$/.test(reply)) return { status: 'clean' };
    const found = /: (.+) FOUND$/.exec(reply);
    if (found) return { status: 'infected', signature: found[1] };
    // Size limit exceeded, scanner error: treat as not safe.
    throw new Error(`Virus scanner could not check the file: ${reply}`);
  }

  private instream(data: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.CLAMAV_HOST, port: this.config.CLAMAV_PORT });
      const chunks: Buffer[] = [];
      socket.setTimeout(60_000, () => socket.destroy(new Error('Virus scanner timed out')));
      socket.on('error', (e) => {
        this.log.error(`clamd: ${e.message}`);
        reject(new Error('Virus scanner is not reachable. Try again in a few minutes.'));
      });
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}
