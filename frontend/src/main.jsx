import './style.css';
import './header.css';
import './chat-theme.css';
import './review.css';
import { createRoot } from 'react-dom/client';
import React from 'react';

const rootElement = document.getElementById('root');
const showStartupError = (error) => {
  rootElement.innerHTML = `<main style="max-width:700px;margin:80px auto;padding:24px;font-family:Arial,sans-serif;color:#202124"><h1 style="color:#d9363e">Unable to start PDF Forge</h1><p>Please copy this message and send it to the developer:</p><pre style="white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:16px;border-radius:8px">${error?.stack || error?.message || String(error)}</pre></main>`;
};

import('./App.jsx').then(({ default: App }) => createRoot(rootElement).render(<App />)).catch(showStartupError);
