import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { reportRendererError } from './errorReporting';
import brandLogo from '@brand/logo.png?url';
import './design/global.css';
import './i18n';

// Phase 0 hardening: the LAST safety net, for whatever a React error boundary
// cannot reach — a throw outside render (a stray event handler, a timer
// callback, an async IPC callback) or a rejected promise nobody awaited.
// Neither of these unmounts the app (React never sees them), so there is no
// fallback UI to show; the goal here is purely that the failure gets LOGGED
// instead of vanishing silently into the devtools console of a window nobody
// is watching. See errorReporting.ts for why there's no toast.
window.addEventListener('error', (e) => {
  reportRendererError({
    source: 'window-error',
    message: e.message || (e.error instanceof Error ? e.error.message : String(e.error)),
    stack: e.error instanceof Error ? e.error.stack : undefined,
    url: e.filename || undefined,
    line: e.lineno || undefined,
    column: e.colno || undefined
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportRendererError({
    source: 'unhandled-rejection',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = brandLogo;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const img = document.createElement('img');
  img.src = brandLogo;
  img.alt = 'The Hive';
  img.style.cssText = 'height:56px;width:auto;display:block';
  splashMark.replaceWith(img);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
