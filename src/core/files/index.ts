/**
 * core/files/index.ts
 *
 * File storage surface: blob adapters + metadata rows.
 */
export { getStorage } from './storage';
export type { StorageAdapter, StorageObject } from './storage';
export type { FileRecord, FileRecordInput } from './metadata';
export {
  createFileRecord,
  getFileRecord,
  listFileRecords,
  softDeleteFileRecord,
} from './metadata';