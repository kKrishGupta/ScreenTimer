import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import App from '../App.jsx';
import { api, ApiError } from '../lib/api.js';

const email = 'reset-user@example.test';
const token = 'a'.repeat(64);
const resetPath = `/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

function renderApp() {
  return render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
}

function fillPasswords(password = 'NewPassword123!', confirmation = password) {
  fireEvent.change(screen.getByLabelText(/New password/i, { selector: 'input' }), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/Confirm password/i, { selector: 'input' }), { target: { value: confirmation } });
}

function submitForm() {
  fireEvent.submit(screen.getByRole('button', { name: 'Update password' }).closest('form'));
}

beforeEach(() => {
  window.history.replaceState(null, '', resetPath);
  vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Sign in required', { status: 401 }));
  vi.spyOn(api, 'logout').mockResolvedValue({ success: true });
  vi.spyOn(api, 'confirmPasswordReset').mockResolvedValue({ success: true });
  vi.spyOn(api, 'requestPasswordReset').mockResolvedValue({ success: true, message: 'If the account exists, check your email for a reset link.' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('confidential password reset page', () => {
  it('captures a valid link and immediately cleans browser and router history under StrictMode', () => {
    // Session loading must not delay credential cleanup.
    api.me.mockImplementation(() => new Promise(() => {}));
    const replace = vi.spyOn(window.history, 'replaceState');
    const historyLength = window.history.length;
    const { container } = renderApp();
    expect(window.location.pathname).toBe('/reset-password');
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(historyLength);
    expect(replace).toHaveBeenCalledWith(expect.anything(), '', '/reset-password');
    expect(screen.getByRole('heading', { name: 'Set a new password' })).toBeInTheDocument();
    expect(container.querySelectorAll('input')).toHaveLength(2);
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
    expect(screen.queryByLabelText(/Reset token|Work email/i)).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(token);
    expect(container.innerHTML).not.toContain(email);
    expect(JSON.stringify(window.history.state)).not.toContain(token);
    expect(screen.getByRole('button', { name: 'Update password' })).toBeEnabled();
  });

  it('keeps credentials through form rerenders and sends the original API payload internally', async () => {
    const localStore = vi.spyOn(Storage.prototype, 'setItem');
    api.confirmPasswordReset.mockRestore();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    fillPasswords();
    fireEvent.click(screen.getByRole('button', { name: 'Show new password' }));
    submitForm();
    await screen.findByRole('status');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/auth/reset-password-confirm');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ email, resetToken: token, newPassword: 'NewPassword123!' });
    expect(localStore).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(document.body.innerHTML).not.toContain(token);
    expect(api.logout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.pathname).toBe('/login'), { timeout: 2500 });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('rejects mismatched passwords without submitting or losing the captured link', async () => {
    renderApp();
    fillPasswords('NewPassword123!', 'DifferentPassword123!');
    submitForm();
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(api.confirmPasswordReset).not.toHaveBeenCalled();
    fillPasswords();
    submitForm();
    await screen.findByRole('status');
    expect(api.confirmPasswordReset).toHaveBeenCalledWith({ email, resetToken: token, newPassword: 'NewPassword123!' });
  });

  it('preserves the minimum password length rule', () => {
    renderApp();
    fillPasswords('short');
    submitForm();
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8 characters');
    expect(api.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'expired', 'already used'])('handles an %s token without rendering server exception text', async (reason) => {
    const logs = ['log', 'warn', 'error', 'info', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    api.confirmPasswordReset.mockRejectedValue(new ApiError(`${reason}: ${token}`, { status: 400, code: 'RESET_FAILED' }));
    renderApp();
    fillPasswords();
    submitForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid, expired, or already used');
    expect(screen.getByRole('link', { name: 'Request a new reset link' })).toHaveAttribute('href', '/forgot-password');
    expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
    expect(document.body.innerHTML).not.toContain(token);
    expect(window.location.href).not.toContain(token);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it('fails safely when refreshing the cleaned URL instead of recovering credentials from storage', () => {
    const firstVisit = renderApp();
    expect(window.location.search).toBe('');
    firstVisit.unmount();
    renderApp();
    expect(screen.getByRole('alert')).toHaveTextContent('missing or no longer available');
    expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
    submitForm();
    expect(api.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('handles a link missing its token and removes any email query', () => {
    window.history.replaceState(null, '', `/reset-password?email=${encodeURIComponent(email)}`);
    renderApp();
    expect(window.location.search).toBe('');
    expect(screen.getByRole('alert')).toHaveTextContent('Request a new reset link');
    expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled();
    submitForm();
    expect(api.confirmPasswordReset).not.toHaveBeenCalled();
  });

  it('allows retry after rate limiting or a service failure without exposing exception text', async () => {
    api.confirmPasswordReset
      .mockRejectedValueOnce(new ApiError(token, { status: 429 }))
      .mockRejectedValueOnce(new ApiError(token, { status: 503 }));
    renderApp();
    fillPasswords();
    submitForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update password' })).toBeEnabled());
    submitForm();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update your password');
    expect(document.body.innerHTML).not.toContain(token);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update password' })).toBeEnabled());
    submitForm();
    await screen.findByRole('status');
  });

  it('keeps login and forgot-password navigation working without displaying development tokens', async () => {
    window.history.replaceState(null, '', '/login');
    api.requestPasswordReset.mockResolvedValue({ success: true, message: 'If the account exists, check your email for a reset link.', resetToken: token });
    renderApp();
    await screen.findByRole('heading', { name: 'Welcome back' });
    fireEvent.click(screen.getByRole('link', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Work email', { selector: 'input' }), { target: { value: email } });
    fireEvent.submit(screen.getByRole('button', { name: 'Send reset link' }).closest('form'));
    expect(await screen.findByRole('status')).toHaveTextContent('check your email');
    expect(window.location.pathname).toBe('/reset-password');
    expect(window.location.search).toBe('');
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
    expect(api.requestPasswordReset).toHaveBeenCalledWith(email);
    expect(document.body.innerHTML).not.toContain(token);
    expect(screen.queryByText('Development reset link')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('blocks repeated submits while email delivery is pending and shows missing-email configuration clearly', async () => {
    window.history.replaceState(null, '', '/forgot-password');
    let failDelivery;
    api.requestPasswordReset.mockImplementation(() => new Promise((_resolve, reject) => { failDelivery = reject; }));
    renderApp();
    const button = await screen.findByRole('button', { name: 'Send reset link' });
    fireEvent.change(screen.getByLabelText('Work email', { selector: 'input' }), { target: { value: email } });
    const form = button.closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(api.requestPasswordReset).toHaveBeenCalledTimes(1);
    failDelivery(new ApiError('Email unavailable', { status: 503, code: 'RESET_EMAIL_NOT_CONFIGURED' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('contact your administrator to enable email delivery');
    expect(window.location.pathname).toBe('/forgot-password');
  });

  it('uses Retry-After from the API to prevent requests during the resend countdown', async () => {
    window.history.replaceState(null, '', '/forgot-password');
    api.requestPasswordReset.mockRestore();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' } }), { status: 429, headers: { 'Retry-After': '1' } }));
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    const button = await screen.findByRole('button', { name: 'Send reset link' });
    fireEvent.change(screen.getByLabelText('Work email', { selector: 'input' }), { target: { value: email } });
    const form = button.closest('form');
    fireEvent.submit(form);
    expect(await screen.findByRole('button', { name: 'Try again in 1s' })).toBeDisabled();
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled(), { timeout: 2500 });
  });
});
