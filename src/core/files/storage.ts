/**
 * core/files/storage.ts
 *
 * Object-storage adapters behind a single interface. R2 (S3-compatible) in
 * production via @aws-sdk/client-s3; a local filesystem adapter for dev so
 * file flows are testable without network. `files` table metadata is written
 * by core/files/metadata.ts; the blob itself lives here.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/core/config/env';

export interface StorageObject {
  body: Uint8Array;
  contentType: string;
}

export interface StorageAdapter {
  put(key: string, body: Uint8Array, contentType: string): Promise<{ sizeBytes: number }>;
  get(key: string): Promise<StorageObject | null>;
  delete(key: string): Promise<void>;
  presignGet(key: string, ttlSeconds?: number): Promise<string>;
}

export class R2Storage implements StorageAdapter {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly publicBaseUrl?: string,
  ) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<{ sizeBytes: number }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<StorageObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      return { body: bytes, contentType: res.ContentType ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignGet(key: string, ttlSeconds = 900): Promise<string> {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl}/${encodeURIComponent(key)}`;
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}

export class LocalStorage implements StorageAdapter {
  constructor(private readonly baseDir: string = path.join(process.cwd(), 'data', 'storage')) {}

  private resolve(key: string): string {
    // Prevent path traversal: keys are storage keys, never user-supplied paths.
    const safe = key.replace(/^[/\\]+/, '').replace(/\.\.(\/|\\)/g, '');
    return path.join(this.baseDir, safe);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<{ sizeBytes: number }> {
    const target = this.resolve(key);
    void contentType; // local fs has no content-type headers; kept for interface parity
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
    return { sizeBytes: body.byteLength };
  }

  async get(key: string): Promise<StorageObject | null> {
    const target = this.resolve(key);
    try {
      await stat(target);
    } catch {
      return null;
    }
    const file = await readFile(target);
    return { body: new Uint8Array(file), contentType: 'application/octet-stream' };
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async presignGet(key: string): Promise<string> {
    return `/files/${encodeURIComponent(key)}`;
  }
}

const defaultStorage: StorageAdapter = env.R2_ACCOUNT_ID
  ? new R2Storage(env.R2_BUCKET_PRIVATE, env.R2_PUBLIC_BASE_URL)
  : new LocalStorage();

let currentStorage: StorageAdapter = defaultStorage;

export function getStorage(): StorageAdapter {
  return currentStorage;
}

/** Test hook: point the app-wide adapter at a throwaway backend. */
export function __useStorageAdapter(adapter: StorageAdapter): void {
  currentStorage = adapter;
}