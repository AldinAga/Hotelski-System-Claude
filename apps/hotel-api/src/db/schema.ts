import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors migrations/*.sql, which stay the source of truth.

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const property = pgTable('property', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Belgrade'),
  currency: char('currency', { length: 3 }).notNull().default('RSD'),
  languages: text('languages').array().notNull().default(['sr', 'en']),
  municipality: text('municipality'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const legalProfile = pgTable('legal_profile', {
  propertyId: uuid('property_id')
    .primaryKey()
    .references(() => property.id),
  kind: text('kind', { enum: ['legal_entity', 'entrepreneur', 'natural_person'] }).notNull(),
  taxId: text('tax_id'),
  registryId: text('registry_id'),
  vatPayer: boolean('vat_payer').notNull().default(false),
});

// One row at most (the singleton key is always true).
export const installationLicence = pgTable('installation_licence', {
  singleton: boolean('singleton').primaryKey().default(true),
  installationId: text('installation_id').notNull(),
  privateSeedEnc: text('private_seed_enc').notNull(),
  envelope: jsonb('envelope').notNull(),
  keySet: jsonb('key_set').notNull(),
  keyChain: jsonb('key_chain').notNull().default([]),
  memory: jsonb('memory').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const USER_ROLES = ['owner', 'manager', 'receptionist', 'housekeeping'] as const;
export type UserRole = (typeof USER_ROLES)[number];
/** See migrations/0004_totp_enrolment.sql. */
export const TOTP_STATES = ['none', 'setup', 'pending', 'confirmed'] as const;
export type TotpState = (typeof TOTP_STATES)[number];

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => property.id),
  email: citext('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role', { enum: USER_ROLES }).notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  totpState: text('totp_state', { enum: TOTP_STATES }).notNull().default('none'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userSession = pgTable('user_session', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => appUser.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// One row at most (the singleton key is always true).
export const setupToken = pgTable('setup_token', {
  singleton: boolean('singleton').primaryKey().default(true),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const loginAttempt = pgTable('login_attempt', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: citext('email').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  propertyId: uuid('property_id'),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
