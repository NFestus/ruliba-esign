import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CryptoService } from '../common/crypto.service';
import { AppConfig, CONFIG } from '../config';

export interface StoredFile {
  storageKey: string;
  wrappedKey: string;
}

/**
 * Encrypted file storage on a local disk (a Docker volume in production).
 * Every file is encrypted with its own key before it touches the disk, so the volume,
 * its backups and the server room copy hold only ciphertext. Decision: local encrypted
 * storage instead of MinIO for the MVP — one server, one less service to run and back up;
 * the brief allows either. An S3 adapter can replace this class later without other changes.
 */
@Injectable()
export class StorageService {
  private readonly root: string;

  constructor(
    private readonly crypto: CryptoService,
    @Inject(CONFIG) config: Pick<AppConfig, 'STORAGE_DIR'>,
  ) {
    this.root = path.resolve(config.STORAGE_DIR);
  }

  private pathFor(storageKey: string) {
    if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.bin$/.test(storageKey)) throw new Error('Invalid storage key');
    const p = path.resolve(this.root, storageKey);
    if (!p.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return p;
  }

  newKey(prefix: string) {
    return `${prefix}/${randomUUID()}.bin`;
  }

  async put(storageKey: string, plain: Buffer): Promise<StoredFile> {
    const { blob, wrappedKey } = this.crypto.encryptFile(plain, storageKey);
    const target = this.pathFor(storageKey);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, blob, { mode: 0o600 });
    await rename(tmp, target); // atomic: a crash never leaves half a file
    return { storageKey, wrappedKey };
  }

  async get(storageKey: string, wrappedKey: string): Promise<Buffer> {
    const blob = await readFile(this.pathFor(storageKey));
    return this.crypto.decryptFile(blob, wrappedKey, storageKey);
  }

  async remove(storageKey: string) {
    await rm(this.pathFor(storageKey), { force: true });
  }
}
