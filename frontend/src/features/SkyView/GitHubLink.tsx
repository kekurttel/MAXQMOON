import React from 'react';
import { useI18n } from '../../i18n';
import './GitHubLink.css';

export default function GitHubLink() {
  const { language } = useI18n();
  const label = language === 'tr' ? 'GitHub üzerinde kaynak kodunu incele (yeni sekme)' : 'View source on GitHub (new tab)';
  return <a className="sv-github-link" href="https://github.com/kekurttel/MAXQMOON" target="_blank" rel="noopener noreferrer" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 .1.77 2.27 3.28 1.62.1-.73.39-1.23.71-1.51-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15A10.8 10.8 0 0 1 12 6.84c.96 0 1.92.13 2.82.38 2.15-1.46 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.64 5.27-5.15 5.55.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z"/></svg>
    <span>GitHub</span><span aria-hidden="true" className="sv-github-arrow">↗</span>
  </a>;
}
