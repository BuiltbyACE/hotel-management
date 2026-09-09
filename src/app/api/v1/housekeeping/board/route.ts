/**
 * GET /api/v1/housekeeping/board?date= → housekeeping.read
 * The room-status grid: condition + housekeeping + today's activity flag.
 */
import { apiHandler, ok, validateQuery } from '@/core/api';
import { today } from '@/core/dates';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getHousekeepingBoard } from '@/modules/housekeeping/service';
import { boardQuerySchema } from '@/modules/housekeeping/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'housekeeping.read');
  const q = validateQuery(new URL(req.url), boardQuerySchema);
  const board = await getHousekeepingBoard(q.date ?? today(), actor);
  return ok({ data: board });
});

export const runtime = 'nodejs';