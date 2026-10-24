import fs from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The Android app turns on phone alerts only once Firebase is set up (android/app/google-services.json):
// asking Firebase for a device token without it crashes the app.
const firebaseReady = fs.existsSync(new URL('./android/app/google-services.json', import.meta.url));

// The API's address is set once, as VITE_API_URL (Railway's variable, else .env.production). The web server's security
// policy (Caddyfile, connect-src) must allow that same address, or the app loads but can't reach the API. Stop a
// production build when the two disagree, instead of shipping an app that silently can't sign anyone in.
function checkApiAddress(mode) {
  const apiUrl = process.env.VITE_API_URL || loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL;
  if (!apiUrl) throw new Error('VITE_API_URL is not set: add it to frontend/.env.production or the Railway variables.');
  const host = new URL(apiUrl).host;
  const caddyfile = fs.readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8');
  const missing = [`https://${host}`, `wss://${host}`].filter((source) => !caddyfile.includes(source));
  if (missing.length) throw new Error(`The API moved to ${host}, but frontend/Caddyfile's Content-Security-Policy doesn't allow ${missing.join(' and ')}. Update connect-src there.`);
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'production') checkApiAddress(mode);
  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_NATIVE_PUSH': JSON.stringify(firebaseReady)
    },
    server: {
      port: 5173,
      host: '0.0.0.0'
    }
  };
});
