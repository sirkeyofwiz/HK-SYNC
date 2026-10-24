import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

// ---------- Notifications ----------
export const PUSH_SUPPORTED = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const IS_IOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
export const IS_STANDALONE = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
export const base64ToBytes = (value) => { const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)); };
// getRegistration() resolves even when no worker is installed (e.g. local development), unlike serviceWorker.ready.
export const pushSubscription = async () => { if (!PUSH_SUPPORTED) return null; const registration = await navigator.serviceWorker.getRegistration(); return registration ? registration.pushManager.getSubscription() : null; };
// The Android app gets alerts through Firebase Cloud Messaging instead of web push; the server keeps its device token next to the
// web push subscriptions. Alerts turn on by themselves in the app; "hk-native-push" = "off" remembers that someone turned them off.
export const IS_NATIVE = Capacitor.isNativePlatform();
export const NATIVE_PUSH = IS_NATIVE && import.meta.env.VITE_NATIVE_PUSH === true;
export const ALERT_CHANNEL = { id: 'alerts', name: 'Alerts', description: 'Messages, tasks and report alerts', importance: 5, visibility: 1, vibration: true };
// Plugins are used directly, never passed through a promise: a Capacitor plugin answers every property, 'then' included,
// so resolving a promise with one waits forever for a native 'then' method that doesn't exist.
export const nativePushToken = async () => {
  const push = PushNotifications;
  const handles = [];
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No answer from Google. Check the internet connection and try again.')), 30000);
      handles.push(push.addListener('registration', ({ value }) => { clearTimeout(timer); resolve(value); }), push.addListener('registrationError', ({ error }) => { clearTimeout(timer); reject(new Error(error)); }));
      push.register().catch(reject);
    });
  } finally { handles.forEach((handle) => handle.then((value) => value.remove()).catch(() => {})); }
};
export const NOTIFY_ICONS = { message: '💬', question: '❓', task: '✓', report_signed: '✍️', report_flagged: '⚠️', inspected: '📋', handover: '🔁', reaction: '👍' };
// A soft two-note chime made in the browser (no sound file to download).
export const playChime = () => { try { const context = new (window.AudioContext || window.webkitAudioContext)(); [[880, 0], [1320, 0.12]].forEach(([frequency, start]) => { const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = frequency; oscillator.type = 'sine'; gain.gain.setValueAtTime(0.0001, context.currentTime + start); gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + 0.35); oscillator.connect(gain).connect(context.destination); oscillator.start(context.currentTime + start); oscillator.stop(context.currentTime + start + 0.4); }); setTimeout(() => context.close(), 1000); } catch { /* sound is optional */ } };
