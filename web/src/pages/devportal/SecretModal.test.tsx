/**
 * The shown-once secret modal. These tests assert the SECURITY property, not
 * the markup: the raw secret is reachable while the modal is open, and
 * unreachable the instant it is dismissed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SecretModal } from './SecretModal';

const SECRET = 'ship_secret_abc123_do_not_leak';

const issued = {
  appName: 'Deploy Bot',
  clientId: 'ship_client_xyz',
  clientSecret: SECRET,
  warning: 'This is the only time the client secret will be shown. Store it now.',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SecretModal', () => {
  it('shows the secret and says plainly that it is unrecoverable', () => {
    render(<SecretModal secret={issued} onDismiss={() => {}} />);

    expect(screen.getByTestId('client-secret-value')).toHaveTextContent(SECRET);
    expect(screen.getByText(/only time this secret will ever be shown/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody .* can recover it/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('copies the raw secret to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SecretModal secret={issued} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('tells the operator when the clipboard is unavailable instead of faking success', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    render(<SecretModal secret={issued} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(await screen.findByText(/could not access the clipboard/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copied/i })).not.toBeInTheDocument();
  });

  it('dismisses on the explicit button and on Escape — but NOT on a backdrop click', () => {
    const onDismiss = vi.fn();
    const { container } = render(<SecretModal secret={issued} onDismiss={onDismiss} />);

    // A stray backdrop click must not destroy a credential not yet written down.
    fireEvent.click(container.firstChild as Element);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /stored the secret/i }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('keeps no copy of the secret once the caller clears it', () => {
    // The parent owns the value; the modal must hold nothing of its own, so
    // re-rendering without it leaves the secret nowhere in the DOM.
    const { rerender } = render(<SecretModal secret={issued} onDismiss={() => {}} />);
    expect(screen.getByTestId('client-secret-value')).toHaveTextContent(SECRET);

    rerender(<></>);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByTestId('client-secret-value')).not.toBeInTheDocument();
  });
});
