import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { readThemeMode, resolveTheme } from './lib/theme';
import './index.css';

const initialThemeMode = readThemeMode();
const initialTheme = resolveTheme(initialThemeMode, window.matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.themeMode = initialThemeMode;
document.documentElement.dataset.theme = initialTheme;
document.documentElement.style.colorScheme = initialTheme;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
