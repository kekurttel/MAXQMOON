import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScenePanel } from './ScenePanel';
import { ShineText } from './ShineText';
import { setLanguage } from '../i18n';

test('panel opens only on request, closes through explicit action and Escape', () => {
  setLanguage('en');
  const close = jest.fn();
  const { rerender } = render(<ScenePanel open={false} title="Regions" onClose={close}><button>Choose region</button></ScenePanel>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(<ScenePanel open title="Regions" onClose={close}><button>Choose region</button></ScenePanel>);
  expect(screen.getByRole('dialog', { name: 'Regions' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Close/ }));
  expect(close).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
  expect(close).toHaveBeenCalledTimes(2);
});

test('shine duplicate is decorative; one accessible button name', () => {
  render(<button><ShineText>Run analysis</ShineText></button>);
  expect(screen.getByRole('button', { name: 'Run analysis' })).toBeInTheDocument();
  expect(document.querySelector('.shine-band')).toHaveAttribute('aria-hidden', 'true');
});
