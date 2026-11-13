import { format, fromMinor } from '@platform/money';

// The e-mails of a reservation, in Serbian (Latin), in the property's own
// voice. The payload is a snapshot taken when the message was queued, so the
// text a guest receives is the text of that moment, however late it is sent.

export const TEMPLATES = ['reservation_confirmed', 'reservation_cancelled'] as const;
export type Template = (typeof TEMPLATES)[number];

export interface ReservationPayloadStay {
  unitTypeName: string | null;
  unitName: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  totalMinor: number;
}

export interface ReservationPayload {
  number: string;
  holderName: string;
  arrival: string;
  departure: string;
  stays: ReservationPayloadStay[];
  totalMinor: number;
  propertyName: string;
  propertyEmail: string | null;
  propertyPhone: string | null;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** '2026-11-02' as '2.11.2026'. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
}

/** 1000000 as '10.000,00 RSD'. */
export function formatMoney(minor: number): string {
  return format(fromMinor(minor, 'RSD'), { symbol: false, code: true });
}

function stayLabel(s: ReservationPayloadStay): string {
  if (s.unitTypeName && s.unitName) return `${s.unitTypeName} (${s.unitName})`;
  return s.unitTypeName ?? s.unitName ?? 'Smeštaj';
}

function stayLine(s: ReservationPayloadStay): string {
  return `${stayLabel(s)}, ${formatDay(s.arrival)} – ${formatDay(s.departure)}, odraslih ${s.adults}, dece ${s.children}: ${formatMoney(s.totalMinor)}`;
}

function contactLine(p: ReservationPayload): string | null {
  const parts: string[] = [];
  if (p.propertyEmail) parts.push(`e-poštom ${p.propertyEmail}`);
  if (p.propertyPhone) parts.push(`telefonom ${p.propertyPhone}`);
  return parts.length ? `Možete nas dobiti ${parts.join(' ili ')}.` : null;
}

export function render(template: Template, payload: ReservationPayload, propertyName: string): RenderedMail {
  const cancelled = template === 'reservation_cancelled';
  const subject = cancelled
    ? `Otkazana rezervacija ${payload.number} — ${propertyName}`
    : `Potvrda rezervacije ${payload.number} — ${propertyName}`;

  const intro = cancelled
    ? `Otkazali smo rezervaciju ${payload.number} u objektu ${propertyName}.`
    : `Potvrđujemo Vašu rezervaciju ${payload.number} u objektu ${propertyName}.`;
  const dates = [`Dolazak: ${formatDay(payload.arrival)}`, `Odlazak: ${formatDay(payload.departure)}`];
  const stays = payload.stays.map(stayLine);
  const total = `Ukupno: ${formatMoney(payload.totalMinor)}`;
  const outro = cancelled
    ? 'Ako je do otkazivanja došlo greškom, javite nam se.'
    : 'Ako treba nešto da promenimo, javite nam se.';
  const contact = contactLine(payload);

  const text = [
    `Dobar dan, ${payload.holderName}.`,
    '',
    intro,
    '',
    ...dates,
    '',
    'Smeštaj:',
    ...stays,
    total,
    '',
    contact ? `${outro} ${contact}` : outro,
    '',
    propertyName,
  ].join('\n');

  const e = escapeHtml;
  const html = [
    '<!doctype html>',
    '<html lang="sr"><head><meta charset="utf-8"><title>' + e(subject) + '</title></head>',
    '<body style="font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.5; color: #1f2933;">',
    `<p>Dobar dan, ${e(payload.holderName)}.</p>`,
    `<p>${e(intro)}</p>`,
    `<p>${dates.map(e).join('<br>')}</p>`,
    '<p><strong>Smeštaj</strong></p>',
    `<ul>${stays.map((s) => `<li>${e(s)}</li>`).join('')}</ul>`,
    `<p><strong>${e(total)}</strong></p>`,
    `<p>${e(contact ? `${outro} ${contact}` : outro)}</p>`,
    `<p>${e(propertyName)}</p>`,
    '</body></html>',
  ].join('\n');

  return { subject, text, html };
}
