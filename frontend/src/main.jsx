import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { Capacitor } from '@capacitor/core';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// The website's offline helper; the installed Android app already carries its files and gets alerts natively.
if ('serviceWorker' in navigator && import.meta.env.PROD && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js'));
}
