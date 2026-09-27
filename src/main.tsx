import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme } from './theme';
import './styles/tokens.css';
import './styles/app.css';

applyTheme();

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
