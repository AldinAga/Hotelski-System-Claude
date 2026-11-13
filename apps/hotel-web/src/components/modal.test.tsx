import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './modal';

function Harness({ busy = false, onClose = () => undefined }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1 tabIndex={-1}>Stranica</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Otvori
      </button>
      {open && (
        <Modal
          title="Naplata"
          busy={busy}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <input aria-label="Prvo polje" />
          <button type="button">Drugo dugme</button>
        </Modal>
      )}
    </main>
  );
}

describe('Modal', () => {
  it('is a labelled dialog and moves focus to its heading', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    const dialog = screen.getByRole('dialog', { name: 'Naplata' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Naplata' })).toHaveFocus();
  });

  it('Escape closes it and focus goes back to the button that opened it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Otvori' });
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('Escape does nothing while a request runs', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness busy onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Tab and Shift+Tab stay inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    const first = screen.getByLabelText('Prvo polje');
    const last = screen.getByRole('button', { name: 'Drugo dugme' });
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab();
    expect(last).toHaveFocus();
    // From the last control forward: back to the first, not out to the page.
    await user.tab();
    expect(first).toHaveFocus();
    // From the first control backward: to the last.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('Shift+Tab from the heading goes to the last control, not out to the page', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    expect(screen.getByRole('heading', { name: 'Naplata' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Drugo dugme' })).toHaveFocus();
  });

  it('locks page scroll while open and releases it on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    expect(document.body).toHaveClass('modal-open');
    await user.keyboard('{Escape}');
    expect(document.body).not.toHaveClass('modal-open');
  });

  it('puts focus on the page heading when the button that opened it is gone', async () => {
    const user = userEvent.setup();
    function Vanishing() {
      const [step, setStep] = useState<'closed' | 'open' | 'gone'>('closed');
      return (
        <main>
          <h1 tabIndex={-1}>Stranica</h1>
          {step !== 'gone' && (
            <button type="button" onClick={() => setStep('open')}>
              Otvori
            </button>
          )}
          {step === 'open' && (
            <Modal title="Storno" onClose={() => setStep('gone')}>
              <button type="button">Zatvori</button>
            </Modal>
          )}
        </main>
      );
    }
    render(<Vanishing />);
    await user.click(screen.getByRole('button', { name: 'Otvori' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Stranica' })).toHaveFocus();
  });
});
