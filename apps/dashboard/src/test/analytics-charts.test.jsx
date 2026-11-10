import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DonutChart } from '../pages/DigitalWellbeingPage.jsx';
import { UsageBreakdown } from '../pages/EmployeeWellbeingPage.jsx';

describe('activity analytics charts', () => {
  it('shows the actual single item and does not invent an Other category', () => {
    render(<DonutChart
      items={[{ name: 'chrome.exe', totalSeconds: 120, percentage: 100 }]}
      totalSeconds={120}
      label="Applications"
    />);
    expect(screen.getByText('chrome.exe')).toBeInTheDocument();
    expect(screen.getByText('100% of total')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('labels a real category explicitly instead of presenting it as the item name', () => {
    render(<DonutChart
      items={[{ name: 'screen-timer.vercel.app', category: 'Other', totalSeconds: 131 }]}
      totalSeconds={131}
      label="Websites"
    />);
    expect(screen.getByText('screen-timer.vercel.app')).toBeInTheDocument();
    expect(screen.getByText('Category: Other')).toBeInTheDocument();
  });

  it('handles empty datasets with an accurate partial-data explanation', () => {
    render(<UsageBreakdown
      title="Website usage breakdown"
      items={[]}
      emptyMessage="No browser-domain activity was synchronized."
    />);
    expect(screen.getByText('No browser-domain activity was synchronized.')).toBeInTheDocument();
  });

  it('keeps displayed breakdown percentages and durations tied to API items', () => {
    render(<UsageBreakdown
      title="Application usage breakdown"
      items={[
        { name: 'Editor.exe', totalSeconds: 90, percentage: 75 },
        { name: 'Terminal.exe', totalSeconds: 30, percentage: 25 },
      ]}
    />);
    expect(screen.getAllByText(/Editor\.exe/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/75%/).length).toBeGreaterThan(0);
    expect(screen.getByText(/25%/)).toBeInTheDocument();
  });
});
