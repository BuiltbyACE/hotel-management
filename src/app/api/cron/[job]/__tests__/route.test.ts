/**
 * POST /api/cron/{job} tests (§15.4): secret gate, the purge-rate-limits job,
 * and unknown-job 404s. Night-audit is exercised via the frontdesk suite.
 */
import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/cron/[job]/route';
import { env } from '@/core/config/env';

const base = 'http://localhost/api/cron';
const cron = (job: string, secret?: string) =>
  new Request(`${base}/${job}`, {
    method: 'POST',
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  });

describe('POST /api/cron/:job', () => {
  it('rejects missing or wrong secrets', async () => {
    await expect(POST(cron('purge-rate-limits'))).rejects.toMatchObject({ status: 401 });
    await expect(POST(cron('purge-rate-limits', 'not-the-secret'))).rejects.toMatchObject({ status: 401 });
  });

  it('runs purge-rate-limits and reports the rows swept', async () => {
    const res = await POST(cron('purge-rate-limits', env.CRON_SECRET));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; job: string; result: unknown };
    expect(body).toMatchObject({ ok: true, job: 'purge-rate-limits' });
    expect(typeof body.result).toBe('number');
  });

  it('rejects unknown jobs even with the right secret', async () => {
    await expect(POST(cron('definitely-not-a-job', env.CRON_SECRET))).rejects.toMatchObject({ status: 404 });
  });
});