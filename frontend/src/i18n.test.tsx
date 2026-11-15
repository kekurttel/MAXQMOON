import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { setLanguage, useI18n } from './i18n';

function LanguageProbe() {
  const { language, setLanguage: changeLanguage, t } = useI18n();
  return <><span>{language}: {t('languageLabel')}</span><button onClick={() => changeLanguage(language === 'tr' ? 'en' : 'tr')}>Switch</button></>;
}

afterEach(() => jest.restoreAllMocks());

test('switches subscribers, document language and persisted preference together', () => {
  render(<LanguageProbe />);
  expect(screen.getByText('tr: Dili değiştir')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
  expect(screen.getByText('en: Switch language')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
  expect(localStorage.getItem('maxqmoon-language')).toBe('en');
  fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
  expect(screen.getByText('tr: Dili değiştir')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('tr');
});

test('language still switches when browser storage is unavailable', () => {
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  render(<LanguageProbe />);
  expect(() => act(() => setLanguage('en'))).not.toThrow();
  expect(screen.getByText('en: Switch language')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
});
