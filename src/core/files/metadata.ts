/**
 * core/files/metadata.ts
 *
 * `files` table record management (mirror in core/db/infra.ts, DDL in
 * drizzle/0001 §5). The blob is in the storage adapter (core/files/storage.ts);
 * this row is the metadata that lets modules reference uploads (logo, guest
 * documents, invoice PDFs, expense receipts).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { files } from '@/core/db/infra';
import type { Db, Tx } from '@/core/db';

export interface FileRecordInput {
  propertyId: string;
  storageKey: string;
  visibility?: 'public' | 'private';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum?: string;
  thumbnailKey?: string;
  entityType?: string;
  entityId?: string;
  uploadedBy: string;
}

export interface FileRecord {
  id: string;
  propertyId: string;
  storageKey: string;
  visibility: 'public' | 'private';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  thumbnailKey: string | null;
  entityType: string | null;
  entityId: string | null;
  uploadedBy: string;
  createdAt: Date;
}

export async function createFileRecord(tx: Tx, input: FileRecordInput): Promise<FileRecord> {
  const [row] = await tx
    .insert(files)
    .values(input)
    .returning({
      id: files.id,
      propertyId: files.propertyId,
      storageKey: files.storageKey,
      visibility: files.visibility,
      originalName: files.originalName,
      mimeType: files.mimeType,
      sizeBytes: files.sizeBytes,
      checksum: files.checksum,
      thumbnailKey: files.thumbnailKey,
      entityType: files.entityType,
      entityId: files.entityId,
      uploadedBy: files.uploadedBy,
      createdAt: files.createdAt,
    });
  return row!;
}

export async function getFileRecord(db: Db, id: string): Promise<FileRecord | null> {
  const [row] = await db.select().from(files).where(and(eq(files.id, id), isNull(files.deletedAt)));
  return row ? mapRow(row) : null;
}

export async function listFileRecords(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<FileRecord[]> {
  const rows = await db
    .select()
    .from(files)
    .where(
      and(isNull(files.deletedAt), eq(files.entityType, entityType), eq(files.entityId, entityId)),
    )
    .orderBy(files.createdAt);
  return rows.map(mapRow);
}

export async function softDeleteFileRecord(tx: Tx, id: string): Promise<void> {
  await tx.update(files).set({ deletedAt: new Date() }).where(eq(files.id, id));
}

function mapRow(r: typeof files.$inferSelect): FileRecord {
  return {
    id: r.id,
    propertyId: r.propertyId,
    storageKey: r.storageKey,
    visibility: r.visibility,
    originalName: r.originalName,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    checksum: r.checksum,
    thumbnailKey: r.thumbnailKey,
    entityType: r.entityType,
    entityId: r.entityId,
    uploadedBy: r.uploadedBy,
    createdAt: r.createdAt,
  };
}