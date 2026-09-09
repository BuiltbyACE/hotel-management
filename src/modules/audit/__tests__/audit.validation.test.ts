/**
 * Unit tests: audit + notifications route schemas.
 */
import { describe, expect, it } from 'vitest';
import { listActivityLogsQuerySchema, listNotificationsQuerySchema } from '../validation';

describe('listActivityLogsQuerySchema', () => {
  it('defaults pagination and leaves filters empty', () => {
    const parsed = listActivityLogsQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(25);
    expect(parsed.entityType).toBeUndefined();
    expect(parsed.from).toBeUndefined();
  });

  it('coerces numeric pagination', () => {
    const parsed = listActivityLogsQuerySchema.parse({ page: '3', pageSize: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  it('rejects invalid uuids and oversized pageSize', () => {
    expect(() => listActivityLogsQuerySchema.parse({ pageSize: 101 })).toThrow();
    expect(() => listActivityLogsQuerySchema.parse({ actorId: 'not-a-uuid' })).toThrow();
    expect(() => listActivityLogsQuerySchema.parse({ page: 0 })).toThrow();
  });

  it('caps long strings', () => {
    expect(() => listActivityLogsQuerySchema.parse({ action: 'a'.repeat(65) })).toThrow();
  });
});

describe('listNotificationsQuerySchema', () => {
  it('defaults includeRead to false', () => {
    const parsed = listNotificationsQuerySchema.parse({});
    expect(parsed.includeRead).toBe(false);
    expect(parsed.page).toBe(1);
  });

  it('parses includeRead=true', () => {
    expect(listNotificationsQuerySchema.parse({ includeRead: 'true' }).includeRead).toBe(true);
  });
});