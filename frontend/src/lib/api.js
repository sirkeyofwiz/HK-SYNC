
// The API's address is the VITE_API_URL setting (Railway's variable, else frontend/.env.production); a trailing "/" or
// "/api" is tolerated. Without it (local development) the local API is used. vite.config.js checks it at build time.
export const API_ORIGIN = (import.meta.env.VITE_API_URL || 'http://localhost:5000').replace(/\/+$/, '').replace(/\/api$/, '');
export const API = `${API_ORIGIN}/api`;
// fetch() fails without an answer only when the phone or the server can't be reached.
export const OFFLINE_MESSAGE = "No connection. Check the Wi-Fi or mobile data and try again.";
