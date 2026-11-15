// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { setLanguage } from './i18n';

// Existing UI assertions use Turkish; individual language tests can switch explicitly.
beforeEach(() => setLanguage('tr'));
