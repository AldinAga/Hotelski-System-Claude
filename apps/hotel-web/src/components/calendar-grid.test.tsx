import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarView } from '@/lib/types';
import { CalendarGrid } from './calendar-grid';

const DBL = '11111111-1111-4111-8111-111111111111';
const SGL = '99999999-9999-4999-8999-999999999999';
const U101 = '22222222-2222-4222-8222-222222222222';
const U102 = '33333333-3333-4333-8333-333333333333';
const U201 = '44444444-4444-4444-8444-444444444444';

const DAYS = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);

function view(over: Partial<CalendarView> = {}): CalendarView {
  return {
    days: DAYS,
    availability: [
      { scope: { kind: 'unit_type', id: DBL }, label: 'Dvokrevetna', free: DAYS.map((_, i) => (i === 2 ? 0 : 1)) },
    ],
    units: [
      {
        id: U101,
        name: 'Soba 101',
        unitTypeId: DBL,
        cleanliness: 'clean',
        bars: [
          {
            kind: 'stay',
            stayId: 's1',
            reservationId: 'r1',
            number: 'R-2026-000001',
            guest: 'Petar Petrović',
            arrival: '2026-11-03',
            departure: '2026-11-06',
            status: 'expected',
          },
          { kind: 'block', blockId: 'b1', from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' },
        ],
      },
      { id: U102, name: 'Soba 102', unitTypeId: DBL, cleanliness: 'dirty', bars: [] },
      { id: U201, name: 'Soba 201', unitTypeId: SGL, cleanliness: 'clean', bars: [] },
    ],
    unassigned: [
      {
        stayId: 's9',
        reservationId: 'r9',
        number: 'R-2026-000009',
        guest: 'Ana Anić',
        unitTypeId: DBL,
        arrival: '2026-11-07',
        departure: '2026-11-09',
      },
    ],
    ...over,
  };
}

function setup(over: Partial<CalendarView> = {}, readOnly = false) {
  const onPickCell = vi.fn();
  const onAssign = vi.fn();
  render(<CalendarGrid view={view(over)} readOnly={readOnly} onPickCell={onPickCell} onAssign={onAssign} />);
  return { onPickCell, onAssign };
}

describe('CalendarGrid', () => {
  it('traka boravka zauzima tačno broj noći', () => {
    setup();
    // Column 1 holds the unit name; 3 Nov is the third day, so column 4; 3 nights.
    const bar = screen.getByRole('link', { name: /R-2026-000001/ });
    expect(bar.style.gridColumn).toBe('4 / span 3');
    expect(bar).toHaveAttribute('href', '/rezervacije/r1');
    expect(bar).toHaveTextContent('Petar Petrović');
    // A block is drawn the same way: 10 and 11 Nov.
    expect(screen.getByTitle(/Blokada/).style.gridColumn).toBe('11 / span 2');
  });

  it('boravak koji počinje pre opsega počinje od prve kolone', () => {
    setup({
      units: [
        {
          id: U101,
          name: 'Soba 101',
          unitTypeId: DBL,
          cleanliness: 'clean',
          bars: [
            {
              kind: 'stay',
              stayId: 's1',
              reservationId: 'r1',
              number: 'R-2026-000001',
              guest: 'Petar Petrović',
              arrival: '2026-10-28',
              departure: '2026-11-03',
              status: 'in_house',
            },
            {
              kind: 'stay',
              stayId: 's2',
              reservationId: 'r2',
              number: 'R-2026-000002',
              guest: 'Jovan Jović',
              arrival: '2026-11-13',
              departure: '2026-11-20',
              status: 'expected',
            },
          ],
        },
      ],
    });
    const early = screen.getByRole('link', { name: /R-2026-000001/ });
    expect(early.style.gridColumn).toBe('2 / span 2');
    expect(early).toHaveClass('cont-before');
    expect(early).not.toHaveClass('cont-after');
    // Leaving after the range: clipped to the last column, marked as going on.
    const late = screen.getByRole('link', { name: /R-2026-000002/ });
    expect(late.style.gridColumn).toBe('14 / span 2');
    expect(late).toHaveClass('cont-after');
  });

  it('a stay the API already clipped to the first day is drawn as possibly continuing', () => {
    setup({
      units: [
        {
          id: U101,
          name: 'Soba 101',
          unitTypeId: DBL,
          cleanliness: 'clean',
          bars: [
            {
              kind: 'stay',
              stayId: 's1',
              reservationId: 'r1',
              number: 'R-2026-000001',
              guest: 'Petar Petrović',
              arrival: '2026-11-01',
              departure: '2026-11-03',
              status: 'in_house',
            },
          ],
        },
      ],
    });
    expect(screen.getByRole('link', { name: /R-2026-000001/ })).toHaveClass('cont-before');
  });

  it('a click on an empty day of a unit asks for a new reservation on that unit and day', async () => {
    const { onPickCell } = setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Soba 102, 4.11.2026' }));
    expect(onPickCell).toHaveBeenCalledWith(U102, '2026-11-04');
  });

  it('shows the free count per type and day', () => {
    setup();
    const row = screen.getByRole('row', { name: 'Slobodno: Dvokrevetna' });
    const cells = within(row).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(DAYS.map((_, i) => (i === 2 ? '0' : '1')));
  });

  it('dragging an unassigned stay onto a unit of its type assigns it; another type does not accept it', () => {
    const { onAssign } = setup();
    const bar = screen.getByRole('link', { name: /R-2026-000009/ });
    expect(bar).toHaveAttribute('draggable', 'true');

    fireEvent.dragStart(bar);
    fireEvent.dragOver(screen.getByRole('row', { name: 'Soba 201' }));
    fireEvent.drop(screen.getByRole('row', { name: 'Soba 201' }));
    expect(onAssign).not.toHaveBeenCalled();

    fireEvent.dragStart(bar);
    fireEvent.dragOver(screen.getByRole('row', { name: 'Soba 102' }));
    fireEvent.drop(screen.getByRole('row', { name: 'Soba 102' }));
    expect(onAssign).toHaveBeenCalledWith('s9', 'r9', U102);
  });

  it('without dragging: a select on the unassigned stay offers only units of its type', async () => {
    const { onAssign } = setup();
    const user = userEvent.setup();
    const item = screen.getByRole('listitem', { name: /R-2026-000009/ });
    const select = within(item).getByLabelText('Jedinica');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Izaberite jedinicu',
      'Soba 101',
      'Soba 102',
    ]);
    await user.selectOptions(select, U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));
    expect(onAssign).toHaveBeenCalledWith('s9', 'r9', U102);
  });

  it('read only (safe mode): no drag, no assign, no new reservation from a cell; bars still shown', () => {
    const { onAssign } = setup({}, true);
    expect(screen.getByRole('link', { name: /R-2026-000001/ })).toBeInTheDocument();
    const bar = screen.getByRole('link', { name: /R-2026-000009/ });
    expect(bar).toHaveAttribute('draggable', 'false');
    fireEvent.dragStart(bar);
    fireEvent.drop(screen.getByRole('row', { name: 'Soba 102' }));
    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Soba 102, 4.11.2026' })).toBeDisabled();
    const item = screen.getByRole('listitem', { name: /R-2026-000009/ });
    expect(within(item).getByRole('button', { name: 'Dodeli' })).toBeDisabled();
  });
});
