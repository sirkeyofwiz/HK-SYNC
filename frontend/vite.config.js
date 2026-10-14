import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Android app turns on phone alerts only once Firebase is set up (android/app/google-services.json):
// asking Firebase for a device token without it crashes the app.
const firebaseReady = fs.existsSync(new URL('./android/app/google-services.json', import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_NATIVE_PUSH': JSON.stringify(firebaseReady)
  },
  server: {
    port: 5173,
    host: '0.0.0.0'
  }
});
