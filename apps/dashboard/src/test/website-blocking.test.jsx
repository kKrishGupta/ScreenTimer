import { expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import WebsiteBlockingControls, { parseBlockedDomains } from '../components/WebsiteBlockingControls.jsx';

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), reload: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: { policies: vi.fn(), createPolicy: mocks.create, updatePolicy: mocks.update } }));
vi.mock('../hooks/useApi.js', () => ({ useApi: () => ({ data: { policies: [{ id: 'policy', active: true, action: 'block', restrictedDomains: ['example.com'] }] }, reload: mocks.reload }) }));
beforeEach(() => vi.clearAllMocks());

it('normalizes URLs and rejects unsupported input', () => {
  expect(parseBlockedDomains('https://YouTube.com/watch?v=1, youtube.com facebook.com')).toEqual(['youtube.com', 'facebook.com']);
  expect(() => parseBlockedDomains('javascript:alert(1)')).toThrow();
  expect(() => parseBlockedDomains('https://user:secret@example.com')).toThrow();
});

it('creates an active block policy and supports disabling it', async () => {
  mocks.create.mockResolvedValue({ success: true });
  mocks.update.mockResolvedValue({ success: true });
  render(<MemoryRouter><WebsiteBlockingControls /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Websites to block'), { target: { value: 'youtube.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Block websites' }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ restrictedDomains: ['youtube.com'], action: 'block', active: true })));
  expect(await screen.findByText(/Blocking policy saved/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Disable blocking' })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: 'Disable blocking' }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('policy', { active: false }));
});
