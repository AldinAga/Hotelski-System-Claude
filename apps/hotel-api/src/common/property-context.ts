import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../db/tokens';
import { property } from '../db/schema';
import { DomainError } from './domain-error';

// An installation has exactly one property; its id is cached after the first hit.
@Injectable()
export class PropertyContext {
  private cached: string | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async id(): Promise<string> {
    if (this.cached) return this.cached;
    const [row] = await this.db.select({ id: property.id }).from(property).limit(1);
    if (!row) {
      throw new DomainError('property_missing', 'Objekat još nije podešen.', 409);
    }
    this.cached = row.id;
    return row.id;
  }
}
