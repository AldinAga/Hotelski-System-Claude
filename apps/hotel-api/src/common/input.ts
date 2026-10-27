import { DomainError } from './domain-error';

// Hand-rolled request body checks (the API has no validation library yet).
// Every failure is 422 validation_failed naming the field.

export type Body = Record<string, unknown>;

export function asBody(body: unknown): Body {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Body) : {};
}

export function validationFailed(field: string, message = `Neispravna vrednost polja "${field}".`): DomainError {
  return new DomainError('validation_failed', message, 422, { field });
}

/** A trimmed, non-empty string of at most `max` characters. */
export function requireText(body: Body, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string') throw validationFailed(field);
  const text = value.trim();
  if (text === '' || text.length > max) throw validationFailed(field);
  return text;
}

/** A string kept as sent (passwords: spaces are part of them). */
export function requireRawString(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw validationFailed(field);
  return value;
}

export function requireOneOf<T extends string>(body: Body, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw validationFailed(field);
  return value as T;
}

// Deliberately loose: one @, something on both sides, no spaces. Delivery is
// what proves an address; this only stops obvious typos.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 254;

export function requireEmail(body: Body, field = 'email'): string {
  const email = requireText(body, field, EMAIL_MAX);
  if (!EMAIL.test(email)) throw validationFailed(field);
  return email;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Postgres unique violation, raw or wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
