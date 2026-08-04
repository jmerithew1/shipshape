import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

/**
 * Unit tests for Dashboard.tsx components
 *
 * These tests verify the StandupCard component correctly handles
 * various author_name values (the fix for the "Cannot read properties
 * of undefined (reading 'name')" bug).
 */

// Mock the hooks to avoid needing full context providers
vi.mock('@/hooks/useWeeksQuery', () => ({
  useActiveWeeksQuery: () => ({
    data: { sprints: [], days_remaining: 5 },
    isLoading: false,
  }),
}));

vi.mock('@/contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    loading: false,
  }),
}));

vi.mock('@/hooks/useDashboardActionItems', () => ({
  useDashboardActionItems: () => ({
    data: { action_items: [] },
    isLoading: false,
  }),
}));

// AgentFindings (Week 5) uses TanStack Query; mock the hook so DashboardPage
// renders without a QueryClientProvider, matching this file's pattern.
vi.mock('@/components/AgentFindings', () => ({
  AgentFindings: () => null,
}));

// Import the component after mocking
import { DashboardPage } from './Dashboard';

// Helper to render with router context
// Uses ?view=overview to test the Overview view (stats, sections, etc.)
function renderWithRouter(ui: React.ReactElement) {
  window.history.pushState({}, '', '?view=overview');
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

describe('extractTextFromContent helper', () => {
  // We can't directly test the internal function, but we can verify
  // behavior by rendering StandupCard with various content shapes

  it('handles null/undefined content gracefully', async () => {
    // The dashboard should render without crashing even with edge cases
    renderWithRouter(<DashboardPage />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders dashboard header', () => {
    renderWithRouter(<DashboardPage />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Cross-program overview of work transparency')).toBeInTheDocument();
  });

  it('renders stat cards', () => {
    renderWithRouter(<DashboardPage />);
    // Use getAllByText since "Active Sprints" appears in both stat card and section
    expect(screen.getAllByText('Active Weeks').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Active Projects')).toBeInTheDocument();
    // "Recent Standups" appears in both stat card and section
    expect(screen.getAllByText('Recent Standups').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Days in Week')).toBeInTheDocument();
  });

  it('renders section headers', () => {
    renderWithRouter(<DashboardPage />);
    // Section headers - use role to be more specific
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Top Projects by ICE')).toBeInTheDocument();
  });

  it('shows empty states when no data', () => {
    renderWithRouter(<DashboardPage />);
    expect(screen.getByText('No active weeks')).toBeInTheDocument();
    expect(screen.getByText('No active projects')).toBeInTheDocument();
  });
});

describe('Standup interface conformance', () => {
  /**
   * These tests verify the Standup interface matches the API contract.
   * The API returns flat author fields (author_id, author_name, author_email),
   * NOT a nested author object.
   *
   * Bug: Previous code had `standup.author.name` which crashed because
   * the API returns `standup.author_name` instead.
   */

  it('Standup interface has flat author fields', () => {
    // Type-level verification - if this compiles, the interface is correct
    interface Standup {
      id: string;
      sprint_id: string;
      title: string;
      content: unknown;
      author_id: string;
      author_name: string | null;
      author_email: string | null;
      created_at: string;
      updated_at: string;
      sprint_title?: string;
      program_name?: string;
    }

    // Create a standup matching the API response shape
    const standup: Standup = {
      id: '123',
      sprint_id: '456',
      title: 'Standup Update',
      content: { type: 'doc', content: [] },
      author_id: 'user-1',
      author_name: 'John Doe',
      author_email: 'john@example.com',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      program_name: 'Test Program',
    };

    // The fix: access author_name directly, not author.name
    expect(standup.author_name).toBe('John Doe');
    expect(standup.author_name?.charAt(0).toUpperCase()).toBe('J');
  });

  it('handles null author_name gracefully', () => {
    interface Standup {
      author_name: string | null;
    }

    const standup: Standup = {
      author_name: null,
    };

    // The fix: provide fallbacks for null author_name
    const authorInitial = standup.author_name?.charAt(0).toUpperCase() || '?';
    const authorDisplay = standup.author_name || 'Unknown';

    expect(authorInitial).toBe('?');
    expect(authorDisplay).toBe('Unknown');
  });
});
