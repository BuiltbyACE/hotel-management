/**
 * core/api/validate.ts
 *
 * Request validation helpers.
 * Raw request.json() is banned by ESLint rule hms/no-direct-request-json.
 * Every mutation must go through validateBody or validateQuery.
 */
import { z, type ZodType } from 'zod';
import { AppError } from './errors';

/**
 * Validate the request body against a Zod schema.
 * Throws AppError.validation on failure.
 */
export async function validateBody<T extends ZodType>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw AppError.badRequest('VALIDATION_ERROR', 'Request body must be valid JSON');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const key = path || '_root';
      if (!errors[key]) errors[key] = [];
      errors[key]!.push(issue.message);
    }
    throw AppError.validation(errors);
  }

  return result.data;
}

/**
 * Validate query parameters against a Zod schema.
 * Throws AppError.validation on failure.
 */
export function validateQuery<T extends ZodType>(
  url: URL,
  schema: T,
): z.infer<T> {
  // Convert URLSearchParams to a plain object
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const key = path || '_root';
      if (!errors[key]) errors[key] = [];
      errors[key]!.push(issue.message);
    }
    throw AppError.validation(errors);
  }

  return result.data;
}
