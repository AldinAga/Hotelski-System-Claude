import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { DocumentsService, type DocumentListItem, type DocumentView } from './documents.service';
import { FolioService, type FolioView, type Written } from './folio.service';

// The folio routes, all hotel.folio. The front desk (receptionist, manager,
// owner) reads folios, charges and takes payments; corrections, refunds and
// voids are for the owner and the manager. In safe mode folio.view and
// folio.pay keep working (SAFE_MODE_ALLOWED: the guests in the house pay and
// leave); folio.charge and folio.correct do not.
//
// A write answers 201 with what it created; a repeated request key answers
// 200 with the first result (FolioService, request keys). Nest fixes one
// status per route, so these handlers send the response themselves.

function send<T>(res: Response, written: Written<T>): void {
  res.status(written.created ? 201 : 200).json(written.view);
}

@Controller()
@Roles('owner', 'manager', 'receptionist')
export class FolioController {
  constructor(
    private readonly folio: FolioService,
    private readonly documents: DocumentsService,
  ) {}

  @Get('stays/:id/folio')
  @LicensedAction('hotel.folio', 'folio.view')
  view(@Param('id') id: string): Promise<FolioView> {
    return this.folio.view(id);
  }

  @Post('stays/:id/folio/charges')
  @LicensedAction('hotel.folio', 'folio.charge')
  async charge(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.folio.charge(id, body, actor));
  }

  @Post('folio-lines/:id/reverse')
  @Roles('owner', 'manager')
  @LicensedAction('hotel.folio', 'folio.correct')
  async reverse(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.folio.reverseLine(id, body, actor));
  }

  @Post('stays/:id/folio/payments')
  @LicensedAction('hotel.folio', 'folio.pay')
  async pay(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.folio.pay(id, body, actor));
  }

  @Post('stays/:id/folio/refunds')
  @Roles('owner', 'manager')
  @LicensedAction('hotel.folio', 'folio.pay')
  async refund(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.folio.refund(id, body, actor));
  }

  @Post('payments/:id/void')
  @Roles('owner', 'manager')
  @LicensedAction('hotel.folio', 'folio.correct')
  async voidPayment(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.folio.voidPayment(id, body, actor));
  }

  // Non-fiscal receipts and pro formas (Task 8); issuing works in safe mode (folio.document).
  @Post('stays/:id/folio/documents')
  @LicensedAction('hotel.folio', 'folio.document')
  async issueDocument(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.documents.issue(id, body, actor));
  }

  @Get('stays/:id/folio/documents')
  @LicensedAction('hotel.folio', 'folio.view')
  documentsOf(@Param('id') id: string): Promise<DocumentListItem[]> {
    return this.documents.list(id);
  }

  @Get('folio-documents/:id')
  @LicensedAction('hotel.folio', 'folio.view')
  document(@Param('id') id: string): Promise<DocumentView> {
    return this.documents.get(id);
  }
}
