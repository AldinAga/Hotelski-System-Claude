import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { asBody } from '../common/input';
import { LicensedAction } from '../licensing/licensed-action';
import {
  ReservationsService,
  type BookInput,
  type BookResult,
  type ReservationSummary,
  type ReservationView,
} from './reservations.service';

// The front desk (receptionist, manager, owner) books, reads and changes
// reservations; housekeeping does not see guests' bookings.

@Controller('reservations')
@Roles('owner', 'manager', 'receptionist')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  @LicensedAction('hotel.core', 'reservation.create')
  book(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<BookResult> {
    // book checks the shape itself (parseBookInput), whoever calls it.
    return this.reservations.book(body as BookInput, actor);
  }

  @Get()
  @LicensedAction('hotel.core', 'reservation.view')
  list(
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('status') status: unknown,
    @Query('q') q: unknown,
  ): Promise<ReservationSummary[]> {
    return this.reservations.list({ from, to, status, q });
  }

  @Get(':id')
  @LicensedAction('hotel.core', 'reservation.view')
  get(@Param('id') id: string): Promise<ReservationView> {
    return this.reservations.get(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'reservation.cancel')
  cancel(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.reservations.cancel(id, asBody(body).version, actor);
  }
}

@Controller('stays')
@Roles('owner', 'manager', 'receptionist')
export class StaysController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post(':id/assign-unit')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'reservation.update')
  assignUnit(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = asBody(body);
    return this.reservations.assignUnit(id, b.unitId, b.version, actor);
  }
}
