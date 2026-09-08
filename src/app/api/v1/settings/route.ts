/**
 * GET   /api/v1/settings  → settings.read
 * PATCH /api/v1/settings  → settings.update (upsert many; JSONB values)
 */
import { apiHandler, ok, validateBody } from '@/core/api';
import { requirePermission } from '@/modules/identity/auth-guard';
import { getSettings, updateSettings } from '@/modules/property/service';
import { updateSettingsSchema } from '@/modules/property/validation';

export const GET = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'settings.read');
  const list = await getSettings(actor);
  return ok(list);
});

export const PATCH = apiHandler(async (req) => {
  const actor = await requirePermission(req, 'settings.update');
  const body = await validateBody(req, updateSettingsSchema);
  const list = await updateSettings(body, actor);
  return ok(list);
});

export const runtime = 'nodejs';