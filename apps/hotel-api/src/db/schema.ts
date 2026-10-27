import {
  bigserial,
  boolean,
  char,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors migrations/*.sql, which stay the source of truth.

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
