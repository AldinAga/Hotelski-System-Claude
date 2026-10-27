import type { LocalizedText } from '../db/schema';
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

/**
 * An optional text field: absent stays undefined, null or blank becomes null,
 * otherwise a trimmed string of at most `max` characters.
 */
export function optionalText(body: Body, field: string, max = 200): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validationFailed(field);
  const text = value.trim();
  if (text.length > max) throw validationFailed(field);
  return text === '' ? null : text;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as YYYY-MM-DD that exists (no 2026-02-30). */
export function requireDate(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw validationFailed(field);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw validationFailed(field);
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

function hasPgCode(err: unknown, code: string): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === code || e?.cause?.code === code;
}

/** Postgres unique violation, raw or wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, '23505');
}

/** Postgres exclusion constraint violation, raw or wrapped by Drizzle. */
export function isExclusionViolation(err: unknown): boolean {
  return hasPgCode(err, '23P01');
}

/** {sr, en?}: sr a non-empty string, en optional. */
export function localized(value: unknown, field: string, required: true): LocalizedText;
export function localized(value: unknown, field: string, required: false): Partial<LocalizedText> | null;
export function localized(value: unknown, field: string, required: boolean): Partial<LocalizedText> | null {
  if (!required && value === null) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationFailed(field);
  const v = value as Record<string, unknown>;
  const out: Partial<LocalizedText> = {};
  if (Object.keys(v).some((k) => k !== 'sr' && k !== 'en')) throw validationFailed(field);
  for (const lang of ['sr', 'en'] as const) {
    const raw = v[lang];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') throw validationFailed(field);
    const text = raw.trim();
    if (text.length > 2000) throw validationFailed(field);
    if (text) out[lang] = text;
  }
  if (required && !out.sr) throw validationFailed(field);
  return out;
}
