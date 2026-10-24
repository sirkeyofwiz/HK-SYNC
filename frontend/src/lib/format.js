import { HK_REPORT_TYPES } from './constants';

// Local calendar date (YYYY-MM-DD). toISOString() is UTC, which is the previous day between 00:00 and 03:00 in Zanzibar.
export const localToday = () => new Date().toLocaleDateString('en-CA');
export const daysAgo = (days) => new Date(Date.now() - days * 86400000).toLocaleDateString('en-CA');
export const nameKey = (name) => String(name || '').trim().toLowerCase();
export const timeAgo = (iso) => { const minutes = Math.round((Date.now() - new Date(iso)) / 60000); if (minutes < 1) return 'now'; if (minutes < 60) return `${minutes} min`; if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h`; return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); };
// How many past report lines carry this housekeeper name (used to confirm a roster rename).
export const countHkLines = (reports, name) => reports.reduce((total, report) => total + ['entries', 'trolleys', 'pantries'].reduce((sum, list) => sum + (Array.isArray(report.data?.[list]) ? report.data[list].filter((entry) => nameKey(entry?.hkName) === nameKey(name)).length : 0), 0), 0);
export const reportHousekeepers = (item) => { if (!HK_REPORT_TYPES.includes(item.type)) return ''; const lines = [...(item.data?.entries || []), ...(item.data?.trolleys || []), ...(item.data?.pantries || [])]; const names = [...new Set(lines.map((line) => String(line?.hkName || '').trim()).filter(Boolean))]; return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '); };
// Vehicle Checklist dashboard: one week (Monday–Sunday) or one month at a time, any past period, filtered by vehicle
// and, for managers, by driver. A checklist "has a problem" when any item is Not OK; items never marked count as OK.
export const isoDate = (date) => date.toLocaleDateString('en-CA');
export const shiftDays = (iso, days) => { const date = new Date(`${iso}T00:00:00`); date.setDate(date.getDate() + days); return isoDate(date); };
export const monthLabel = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: 'short', year: '2-digit' });
export const timeLabel = (iso) => { const date = new Date(iso); return date.toLocaleDateString('en-CA') === localToday() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString([], { day: 'numeric', month: 'short' }); };
export const initials = (name = '') => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();
export const clockLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const durationLabel = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
export const listTime = (iso) => { if (!iso) return ''; const key = new Date(iso).toLocaleDateString('en-CA'); const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); return key === localToday() ? clockLabel(iso) : key === yesterday.toLocaleDateString('en-CA') ? 'Yesterday' : new Date(iso).toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' }); };
export const dayLabel = (iso) => { const date = new Date(iso); const key = date.toLocaleDateString('en-CA'); const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); if (key === localToday()) return 'Today'; if (key === yesterday.toLocaleDateString('en-CA')) return 'Yesterday'; return date.toLocaleDateString([], { day: 'numeric', month: 'long', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
export const deadlineLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
export const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(`${iso}T23:59:59`) - new Date()) / 86400000));
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// ---------- Report detail ----------
export const reportLineLabel = (type, list, entry, index) => list === 'trolleys' ? (entry.block ? `Trolley · Block ${entry.block}` : `Trolley ${index + 1}`) : list === 'pantries' ? (entry.block ? `Pantry · Block ${entry.block}` : `Pantry ${index + 1}`) : type === 'tools' ? entry.tool || `Tool ${index + 1}` : type === 'guest_interaction' ? entry.hkName || `Housekeeper ${index + 1}` : entry.room ? `Room ${entry.room}` : `Line ${index + 1}`;
// Manager only: nightly off-site backups (status, run now) and a downloadable copy to keep elsewhere.
export const whenText = (iso) => { const ago = timeAgo(iso); return ago === 'now' ? 'just now' : /\d (min|h)$/.test(ago) ? `${ago} ago` : `on ${ago}`; };
