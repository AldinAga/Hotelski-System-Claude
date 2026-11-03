import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { asBody, EMAIL_MAX, isUuid, optionalText, requireText, validationFailed, type Body } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import type { Actor } from '../reservations/reservations.service';

// Guests and the guests of each stay (spec 5.4). The holder of a reservation
// is the primary guest of each of its stays (book writes it, migration 0008
// backfilled it); the front desk adds the others. Guest changes never bump
// reservation.version: they are not a status change.
//
// Locks for a stay's guests: the reservation row (FOR UPDATE), then the stay
// row (FOR UPDATE), the same order as assignUnit; that is what serialises two
// additions to one stay against each other and against cancel.

export interface GuestInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  language?: string;
  note?: string | null;
}

export interface GuestView {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  language: string;
  note: string | null;
}

export type StayGuestView = GuestView & { isPrimary: boolean };

export const GUEST_NOTE_MAX = 2000;
const SEARCH_LIMIT = 50;
const LANGUAGE = /^[a-z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const guestNotFound = () => new DomainError('guest_not_found', 'Gost ne postoji.', 404);
const stayNotFound = () => new DomainError('stay_not_found', 'Boravak ne postoji.', 404);
const guestNotOnStay = () => new DomainError('guest_not_on_stay', 'Gost nije na ovom boravku.', 404);

function at<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch {
    throw validationFailed(path);
  }
}

/**
 * The field rules of a guest, shared by POST/PATCH /guests, a guest added to
 * a stay and the holder of a booking (parseBookInput): names 1–100
 * characters, e-mail checked loosely, phone up to 50, language two lowercase
 * letters, note up to 2000. `prefix` names the field in errors
 * ('holder.firstName'). With `partial`, every field is optional (PATCH);
 * without `note`, a note is ignored (the holder has none).
 */
export function parseGuestInput(raw: unknown, prefix = '', opts: { partial?: boolean; note?: boolean } = {}): Partial<GuestInput> {
  const b: Body = asBody(raw);
  const out: Partial<GuestInput> = {};
  for (const field of ['firstName', 'lastName'] as const) {
    if (opts.partial && b[field] === undefined) continue;
    out[field] = at(prefix + field, () => requireText(b, field, 100));
  }
  const email = at(prefix + 'email', () => optionalText(b, 'email', EMAIL_MAX));
  if (email !== undefined) {
    if (email !== null && !EMAIL.test(email)) throw validationFailed(prefix + 'email');
    out.email = email;
  }
  const phone = at(prefix + 'phone', () => optionalText(b, 'phone', 50));
  if (phone !== undefined) out.phone = phone;
  const language = at(prefix + 'language', () => optionalText(b, 'language', 2));
  if (language !== undefined && language !== null) {
    if (!LANGUAGE.test(language)) throw validationFailed(prefix + 'language');
    out.language = language;
  } else if (language === null && opts.partial) {
    throw validationFailed(prefix + 'language');
  }
  if (opts.note !== false) {
    const note = at(prefix + 'note', () => optionalText(b, 'note', GUEST_NOTE_MAX));
    if (note !== undefined) out.note = note;
  }
  return out;
}

type GuestRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  language: string;
  note: string | null;
};

const GUEST_COLUMNS = sql`g.id, g.first_name, g.last_name, g.email::text AS email, g.phone, g.language, g.note`;

function viewOf(r: GuestRow): GuestView {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    email: r.email,
    phone: r.phone,
    language: r.language,
    note: r.note,
  };
}

/**
 * The guests of the stays of one reservation, or of one stay: primary first,
 * then in the order they were added. Keyed by stay id.
 */
export async function stayGuestsOf(
  tx: Tx,
  propertyId: string,
  by: { reservationId: string } | { stayId: string },
): Promise<Map<string, StayGuestView[]>> {
  const where =
    'reservationId' in by
      ? sql`s.reservation_id = ${by.reservationId}`
      : sql`s.id = ${by.stayId}`;
  const { rows } = await tx.execute<GuestRow & { stay_id: string; is_primary: boolean }>(sql`
    SELECT sg.stay_id, sg.is_primary, ${GUEST_COLUMNS}
      FROM stay_guest sg
      JOIN stay s ON s.id = sg.stay_id AND s.property_id = sg.property_id
      JOIN guest g ON g.id = sg.guest_id AND g.property_id = sg.property_id
     WHERE sg.property_id = ${propertyId} AND ${where}
     ORDER BY sg.is_primary DESC, sg.added_at, g.id`);
  const out = new Map<string, StayGuestView[]>();
  for (const r of rows) {
    const list = out.get(r.stay_id) ?? [];
    list.push({ ...viewOf(r), isPrimary: r.is_primary });
    out.set(r.stay_id, list);
  }
  return out;
}

type LockedStay = { id: string; status: string; adults: number; children: number };

@Injectable()
export class GuestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
  ) {}

  /** First name, last name (either order), e-mail or phone containing `q`; % and _ match literally. At most 50. */
  async search(q: unknown): Promise<GuestView[]> {
    if (q !== undefined && (typeof q !== 'string' || q.trim().length > 100)) throw validationFailed('q');
    const term = typeof q === 'string' ? q.trim() : '';
    const propertyId = await this.property.id();
    let filter: SQL = sql``;
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filter = sql`AND ((g.first_name || ' ' || g.last_name) ILIKE ${like} OR (g.last_name || ' ' || g.first_name) ILIKE ${like}
        OR g.email::text ILIKE ${like} OR g.phone ILIKE ${like})`;
    }
    const { rows } = await this.db.execute<GuestRow>(sql`
      SELECT ${GUEST_COLUMNS} FROM guest g
       WHERE g.property_id = ${propertyId} ${filter}
       ORDER BY g.last_name, g.first_name, g.id
       LIMIT ${SEARCH_LIMIT}`);
    return rows.map(viewOf);
  }

  async create(raw: unknown, actor: Actor): Promise<GuestView> {
    const input = parseGuestInput(raw) as GuestInput;
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      const g = await this.insertGuest(tx, propertyId, input);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'guest.create',
        entity: 'guest',
        entityId: g.id,
        after: { firstName: g.firstName, lastName: g.lastName, language: g.language },
      });
      return g;
    });
  }

  async update(id: string, raw: unknown, actor: Actor): Promise<GuestView> {
    if (!isUuid(id)) throw guestNotFound();
    const patch = parseGuestInput(raw, '', { partial: true });
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<GuestRow>(
        sql`SELECT ${GUEST_COLUMNS} FROM guest g WHERE g.id = ${id} AND g.property_id = ${propertyId} FOR UPDATE`,
      );
      if (!rows[0]) throw guestNotFound();
      const before = viewOf(rows[0]);
      const columns: Record<keyof GuestInput, string> = {
        firstName: 'first_name',
        lastName: 'last_name',
        email: 'email',
        phone: 'phone',
        language: 'language',
        note: 'note',
      };
      const fields = (Object.keys(patch) as Array<keyof GuestInput>).filter((k) => patch[k] !== before[k]);
      if (fields.length === 0) return before;
      const sets = fields.map((k) => sql`${sql.identifier(columns[k])} = ${patch[k] ?? null}`);
      const { rows: updated } = await tx.execute<GuestRow>(sql`
        UPDATE guest g SET ${sql.join(sets, sql`, `)}
         WHERE g.id = ${id} AND g.property_id = ${propertyId}
         RETURNING ${GUEST_COLUMNS}`);
      const after = viewOf(updated[0]);
      // Field names only: e-mail and phone values stay out of the audit trail.
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'guest.update',
        entity: 'guest',
        entityId: id,
        before: { firstName: before.firstName, lastName: before.lastName },
        after: { firstName: after.firstName, lastName: after.lastName, fields },
      });
      return after;
    });
  }

  /**
   * Puts a guest on a stay: an existing one (`guestId`) or a new one
   * (`guest`, created here). The stay must be expected or in house
   * (409 stay_not_editable); the stay holds at most adults + children guests
   * (422 too_many_guests); a guest is on a stay once (409 guest_already_on_stay).
   */
  async addToStay(stayId: string, raw: unknown, actor: Actor): Promise<StayGuestView[]> {
    if (!isUuid(stayId)) throw stayNotFound();
    const b = asBody(raw);
    let guestId: string | null = null;
    let input: GuestInput | null = null;
    if (b.guestId !== undefined) {
      if (typeof b.guestId !== 'string' || !isUuid(b.guestId)) throw validationFailed('guestId');
      guestId = b.guestId.toLowerCase();
    } else if (b.guest !== undefined) {
      input = parseGuestInput(b.guest, 'guest.') as GuestInput;
    } else {
      throw validationFailed('guestId', 'Navedite postojećeg gosta (guestId) ili novog gosta (guest).');
    }
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      const stay = await this.lockEditableStay(tx, propertyId, stayId);
      if (guestId) {
        const { rows } = await tx.execute<{ id: string }>(
          sql`SELECT id FROM guest WHERE id = ${guestId} AND property_id = ${propertyId}`,
        );
        if (!rows[0]) throw guestNotFound();
        const { rows: on } = await tx.execute(
          sql`SELECT 1 FROM stay_guest WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND guest_id = ${guestId}`,
        );
        if (on[0]) throw new DomainError('guest_already_on_stay', 'Gost je već na ovom boravku.', 409, { guestId });
      }
      const { rows: counted } = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM stay_guest WHERE property_id = ${propertyId} AND stay_id = ${stayId}`,
      );
      const limit = stay.adults + stay.children;
      if (counted[0].n + 1 > limit) {
        throw new DomainError('too_many_guests', `Na boravku može biti najviše ${limit} gostiju.`, 422, { limit });
      }
      const created = input ? await this.insertGuest(tx, propertyId, input) : null;
      const id = created ? created.id : guestId!;
      await tx.execute(sql`
        INSERT INTO stay_guest (property_id, stay_id, guest_id, is_primary)
        VALUES (${propertyId}, ${stayId}, ${id}, false)`);
      if (created) {
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'guest.create',
          entity: 'guest',
          entityId: id,
          after: { firstName: created.firstName, lastName: created.lastName, language: created.language },
        });
      }
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'stay.guest_add',
        entity: 'stay',
        entityId: stayId,
        after: { guestId: id },
      });
      return this.guestsOfStay(tx, propertyId, stayId);
    });
  }

  /** Takes a guest off a stay (the guest record stays). The primary guest cannot go: 409 primary_guest_required. */
  async removeFromStay(stayId: string, guestId: string, actor: Actor): Promise<StayGuestView[]> {
    if (!isUuid(stayId)) throw stayNotFound();
    if (!isUuid(guestId)) throw guestNotOnStay();
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      await this.lockEditableStay(tx, propertyId, stayId);
      const row = await this.stayGuest(tx, propertyId, stayId, guestId);
      if (row.is_primary) {
        throw new DomainError('primary_guest_required', 'Nosilac boravka se ne može ukloniti; prvo odredite drugog nosioca.', 409);
      }
      await tx.execute(
        sql`DELETE FROM stay_guest WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND guest_id = ${guestId}`,
      );
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'stay.guest_remove',
        entity: 'stay',
        entityId: stayId,
        before: { guestId },
      });
      return this.guestsOfStay(tx, propertyId, stayId);
    });
  }

  /** Makes a guest of the stay its primary guest, in one transaction: the old one is cleared first. */
  async setPrimary(stayId: string, guestId: string, actor: Actor): Promise<StayGuestView[]> {
    if (!isUuid(stayId)) throw stayNotFound();
    if (!isUuid(guestId)) throw guestNotOnStay();
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      await this.lockEditableStay(tx, propertyId, stayId);
      const row = await this.stayGuest(tx, propertyId, stayId, guestId);
      if (!row.is_primary) {
        // Two statements: the partial unique index (one primary per stay) is
        // not deferrable, so the old primary is cleared before the new is set.
        const { rows: old } = await tx.execute<{ guest_id: string }>(sql`
          UPDATE stay_guest SET is_primary = false
           WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND is_primary
           RETURNING guest_id`);
        await tx.execute(sql`
          UPDATE stay_guest SET is_primary = true
           WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND guest_id = ${guestId}`);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'stay.guest_primary',
          entity: 'stay',
          entityId: stayId,
          before: { guestId: old[0]?.guest_id ?? null },
          after: { guestId },
        });
      }
      return this.guestsOfStay(tx, propertyId, stayId);
    });
  }

  /**
   * Gives a stay without a primary guest its reservation's holder as primary
   * (check-in, Task 5). A holder already on the stay becomes primary; a stay
   * that has one is left alone. Call inside the caller's transaction, with the
   * reservation row locked.
   */
  async ensurePrimary(tx: Tx, propertyId: string, stayId: string): Promise<void> {
    await tx.execute(sql`
      INSERT INTO stay_guest (property_id, stay_id, guest_id, is_primary)
      SELECT s.property_id, s.id, r.holder_guest_id, true
        FROM stay s JOIN reservation r ON r.id = s.reservation_id AND r.property_id = s.property_id
       WHERE s.id = ${stayId} AND s.property_id = ${propertyId}
         AND NOT EXISTS (SELECT 1 FROM stay_guest x WHERE x.property_id = s.property_id AND x.stay_id = s.id AND x.is_primary)
      ON CONFLICT (stay_id, guest_id) DO UPDATE SET is_primary = true`);
  }

  // ---- helpers ----

  private async insertGuest(tx: Tx, propertyId: string, g: GuestInput): Promise<GuestView> {
    const { rows } = await tx.execute<GuestRow>(sql`
      INSERT INTO guest AS g (property_id, first_name, last_name, email, phone, language, note)
      VALUES (${propertyId}, ${g.firstName}, ${g.lastName}, ${g.email ?? null}, ${g.phone ?? null}, ${g.language ?? 'sr'}, ${g.note ?? null})
      RETURNING ${GUEST_COLUMNS}`);
    return viewOf(rows[0]);
  }

  /** Locks the stay's reservation, then the stay; 404 stay_not_found, 409 stay_not_editable unless expected or in house. */
  private async lockEditableStay(tx: Tx, propertyId: string, stayId: string): Promise<LockedStay> {
    const { rows: found } = await tx.execute<{ reservation_id: string }>(
      sql`SELECT reservation_id FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}`,
    );
    if (!found[0]) throw stayNotFound();
    await tx.execute(
      sql`SELECT id FROM reservation WHERE id = ${found[0].reservation_id} AND property_id = ${propertyId} FOR UPDATE`,
    );
    const { rows } = await tx.execute<LockedStay>(
      sql`SELECT id, status, adults, children FROM stay WHERE id = ${stayId} AND property_id = ${propertyId} FOR UPDATE`,
    );
    const stay = rows[0];
    if (stay.status !== 'expected' && stay.status !== 'in_house') {
      throw new DomainError('stay_not_editable', 'Gosti se ne mogu menjati na boravku u ovom stanju.', 409, {
        status: stay.status,
      });
    }
    return stay;
  }

  private async stayGuest(tx: Tx, propertyId: string, stayId: string, guestId: string): Promise<{ is_primary: boolean }> {
    const { rows } = await tx.execute<{ is_primary: boolean }>(sql`
      SELECT is_primary FROM stay_guest
       WHERE property_id = ${propertyId} AND stay_id = ${stayId} AND guest_id = ${guestId}
         FOR UPDATE`);
    if (!rows[0]) throw guestNotOnStay();
    return rows[0];
  }

  private async guestsOfStay(tx: Tx, propertyId: string, stayId: string): Promise<StayGuestView[]> {
    return (await stayGuestsOf(tx, propertyId, { stayId })).get(stayId) ?? [];
  }
}
