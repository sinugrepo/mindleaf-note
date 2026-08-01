import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SortDropdown } from '../components/SortDropdown';
import { useStore } from '../store/useStore';

describe('SortDropdown', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      sortMode: 'manual',
      sortDirection: 'asc',
      tagFilter: [],
    });
  });

  it('changes the sort field', () => {
    render(<SortDropdown visible />);

    fireEvent.change(screen.getByLabelText('Sort field'), {
      target: { value: 'title' },
    });

    expect(useStore.getState().sortMode).toBe('title');
  });

  it('toggles between ascending and descending', () => {
    render(<SortDropdown visible />);
    const direction = screen.getByRole('button', {
      name: /Sort direction: Ascending/i,
    });

    fireEvent.click(direction);

    expect(useStore.getState().sortDirection).toBe('desc');
    expect(screen.getByRole('button', {
      name: /Sort direction: Descending/i,
    })).toBeInTheDocument();
  });

  it('is hidden when the parent view is not sortable', () => {
    render(<SortDropdown visible={false} />);
    expect(screen.queryByTestId('sort-dropdown')).not.toBeInTheDocument();
  });
});
