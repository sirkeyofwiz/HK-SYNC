import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { PushNotifications } from '@capacitor/push-notifications';
import { ConfirmHost, confirmAction } from './components/ConfirmDialog';
import { Empty } from './components/ui';
import { Account, Backups, NotificationSettings } from './features/account/Account';
import { Bell, PushBanner } from './features/account/Alerts';
import { Login, ResetPassword } from './features/auth/Login';
import { Goals, rosterProblem } from './features/goals/Goals';
import { AskDialog } from './features/messages/Ask';
import { Messages } from './features/messages/Messages';
import { DriverHome, Overview } from './features/overview/Overview';
import { HkProfile, ProfileList, SupervisorProfile, SupervisorProfileList } from './features/people/Profiles';
import { StaffAccounts } from './features/people/StaffAccounts';
import { ReportDetail } from './features/reports/ReportDetail';
import { ReportForm } from './features/reports/ReportForm';
import { Reports } from './features/reports/Reports';
import { vehicleItemState, vehicleProblems } from './features/reports/VehicleChecks';
import { TaskModal, TaskView, Tasks } from './features/tasks/Tasks';
import { API, API_ORIGIN, OFFLINE_MESSAGE } from './lib/api';
import { TYPES, VEHICLE, emptyEntry, focusMatch, reportKind, typesForRole } from './lib/constants';
import { draftKey, draftTime, dropDraft, loadDraft, saveDraft } from './lib/drafts';
import { SAVED_FOLDER, compressPhoto, openNativeFile, saveFile } from './lib/files';
import { localToday, plural } from './lib/format';
import { MANAGER_PAGES, parseRoute, routePath } from './lib/routes';
import { ALERT_CHANNEL, IS_IOS, IS_STANDALONE, NATIVE_PUSH, NOTIFY_ICONS, PUSH_SUPPORTED, base64ToBytes, nativePushToken, playChime, pushSubscription } from './lib/push';


export default function App() {
  const [token, setToken] = useState(localStorage.getItem('bahari-token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('bahari-user') || 'null'));
  // The address the app was opened at (a refresh or a shared link) decides the first screen; see lib/routes.js.
  const [startRoute] = useState(() => parseRoute(window.location));
  const [page, setPage] = useState(startRoute.page === 'new' ? 'overview' : startRoute.page);
  const [reports, setReports] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [staff, setStaff] = useState([]);
  const [message, setMessage] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [emailReset, setEmailReset] = useState(false);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [reportType, setReportType] = useState('neglected');
  const [report, setReport] = useState({ date: localToday(), area: '', block: '', vehicleId: '', supervisorId: '', entries: [emptyEntry('neglected')], trolleys: [], pantries: [], needsManager: false, managerTopic: '', managerNote: '', handoverFrom: '', receivedBy: '', emergencyRoomsReady: '', vipRooms: '', repeaterRooms: '', roomsToCheck: '', roomsToClean: '', showerRooms: '', turndownRooms: '', extraTasks: '', notes: '' });
  const [filters, setFilters] = useState({ tab: 'reports', type: '', search: '', date: '' });
  const [taskDraft, setTaskDraft] = useState(null);
  const [staffForm, setStaffForm] = useState({ name: '', email: '', password: '', role: 'supervisor' });
  const [conversations, setConversations] = useState([]);
  const [chatGroups, setChatGroups] = useState([]);
  const [goals, setGoals] = useState(null);
  const [performance, setPerformance] = useState(null); // Overview: who is doing well / needs support (managers)
  const [hkRoster, setHkRoster] = useState([]);
  const [profile, setProfile] = useState(startRoute.profile);
  const [reportView, setReportView] = useState(startRoute.reportId ? { id: startRoute.reportId, line: null, returnTo: 'reports' } : null);
  // The open report form's draft: which slot it saves to, the form as it opened (a draft is kept only once it differs),
  // and what the note above the form says.
  const draftKeyRef = useRef(null);
  const draftBase = useRef('');
  const draftPending = useRef(null);
  const [draftNote, setDraftNote] = useState(null);
  // The header's save status: is the phone online, is the server reachable, is anything being saved, did the last save fail.
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [serverReachable, setServerReachable] = useState(true);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [taskView, setTaskView] = useState(startRoute.taskId);
  const [askFor, setAskFor] = useState(null);
  const [askVersion, setAskVersion] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [notifyPrefs, setNotifyPrefs] = useState(null);
  const [pushState, setPushState] = useState('checking');
  const [bannerHidden, setBannerHidden] = useState(() => { try { return localStorage.getItem('hk-push-banner') === 'hidden'; } catch { return false; } });
  const notifyPrefsRef = useRef(null);
  const goalsYearRef = useRef(null); // null = the current goals year; set while looking back at a past year
  notifyPrefsRef.current = notifyPrefs;
  const [activeChat, setActiveChat] = useState(startRoute.chatId);
  const [chatMessages, setChatMessages] = useState([]);
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset') || '');
  // Socket handlers are bound once per login, so they read the open conversation through a ref.
  const openChatRef = useRef(null);
  const socketRef = useRef(null);
  const [typingIds, setTypingIds] = useState([]);
  const [typingWho, setTypingWho] = useState({}); // group id -> who is typing in it
  const meRef = useRef(null);
  meRef.current = user?.id || null;
  const typingTimers = useRef({});
  const lastTypingSent = useRef(0);
  openChatRef.current = page === 'messages' ? activeChat : null;
  const isManager = ['manager', 'assistant_manager'].includes(user?.role);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const request = async (path, options = {}) => { const saving = (options.method || 'GET') !== 'GET'; if (saving) setPendingSaves((count) => count + 1); try { let res; try { res = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } }); } catch { if (saving) setSaveFailed(true); const error = new Error(OFFLINE_MESSAGE); error.offline = true; throw error; } if (saving) setSaveFailed(false); const data = await res.json().catch(() => ({})); if (res.status === 401 && !path.startsWith('/auth/')) { signOut(); setMessage('Your session has ended. Please sign in again.'); } if (!res.ok) throw new Error(data.message || (res.status === 413 ? 'Upload is too large. Try fewer or smaller photos.' : `Request failed (${res.status}).`)); return data; } finally { if (saving) setPendingSaves((count) => count - 1); } };
  const refresh = async () => { if (!token) return; lastRefreshRef.current = Date.now(); try { const manager = ['manager', 'assistant_manager'].includes(user?.role); const [r, t, s, g, h, n, np, perf] = await Promise.all([request('/reports'), request('/tasks'), request('/users/all'), manager ? request(goalsYearRef.current ? `/goals?year=${goalsYearRef.current}` : '/goals') : null, request('/hk-roster'), request('/notifications'), request('/users/me/notify'), manager ? request('/hk-performance') : null]); setReports(r.reports || []); setTasks(t.tasks || []); setStaff(s.users || []); setGoals(g?.goals || null); setPerformance(perf || null); setHkRoster(h.names || []); setAlerts(n.notifications || []); setNotifyPrefs(np.settings || null); } catch (error) { setMessage(error.message); } };
  useEffect(() => { refresh(); }, [token]);
  // Keep the screens current without a restart: reload when someone else changes reports, tasks or goals (the server says so),
  // when the app comes back to the screen, and after reconnecting. Bursts are merged into one reload.
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const lastRefreshRef = useRef(0);
  const refreshTimerRef = useRef(null);
  const refreshSoon = (delay = 1200) => { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = setTimeout(() => { lastRefreshRef.current = Date.now(); refreshRef.current(); }, delay); };
  useEffect(() => { if (!token) return undefined; const back = () => { if (document.visibilityState === 'visible' && Date.now() - lastRefreshRef.current > 20000) refreshSoon(300); }; document.addEventListener('visibilitychange', back); return () => { document.removeEventListener('visibilitychange', back); clearTimeout(refreshTimerRef.current); }; }, [token]);
  useEffect(() => { fetch(`${API}/auth/options`).then((res) => res.json()).then((options) => setEmailReset(Boolean(options.emailReset))).catch(() => setEmailReset(false)); }, []);
  const loadConversations = async () => { try { const data = await request('/messages'); setConversations(data.conversations || []); setChatGroups(data.groups || []); } catch { /* shown on the next action */ } };
  // The conversation a message belongs to: its group, or the other person.
  const chatKey = (item) => item.groupId || (item.senderId === meRef.current ? item.receiverId : item.senderId);
  const createGroup = async (name, memberIds) => { try { const { group } = await request('/groups', { method: 'POST', body: JSON.stringify({ name, memberIds }) }); await loadConversations(); openChat(group.id); return true; } catch (error) { setMessage(error.message); return false; } };
  const updateGroup = async (id, changes) => { try { await request(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }); await loadConversations(); if (openChatRef.current === id) openChat(id); return true; } catch (error) { setMessage(error.message); return false; } };
  const leaveGroup = async (id) => { try { await request(`/groups/${id}/leave`, { method: 'POST' }); openChat(null); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  const groupActions = { create: createGroup, update: updateGroup, leave: leaveGroup };
  const markRead = async (userId) => { try { await request(`/messages/${userId}/read`, { method: 'POST' }); loadConversations(); } catch { /* not critical */ } };
  const openChat = async (userId) => { setActiveChat(userId); setChatMessages([]); if (!userId) return; try { setChatMessages((await request(`/messages/${userId}`)).messages || []); markRead(userId); } catch (error) { setMessage(error.message); } };
  // Files go up first (photos shrunk like report photos), then the message references them.
  const uploadAttachment = async (blob, name, duration) => { const res = await fetch(`${API}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || ''), ...(duration ? { 'X-Duration': String(duration) } : {}) }, body: blob }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.message || (res.status === 413 ? 'That file is over 10 MB.' : `Upload failed (${res.status}).`)); return data.attachment; };
  const upsertChatMessage = (incoming) => setChatMessages((current) => current.some((item) => item.id === incoming.id) ? current.map((item) => item.id === incoming.id ? incoming : item) : [...current, incoming]);
  const sendChat = async ({ text, files = [], replyTo }) => { try { const uploaded = []; for (const file of files) { const photo = file.type.startsWith('image/') && file.type !== 'image/gif'; const blob = photo ? await (await fetch(await compressPhoto(file))).blob() : file; uploaded.push(await uploadAttachment(blob, photo ? `${file.name.replace(/\.[^.]+$/, '')}.jpg` : file.name)); } const { message: sent } = await request('/messages', { method: 'POST', body: JSON.stringify({ receiverId: activeChat, text, attachments: uploaded.map((attachment) => attachment.id), replyTo }) }); upsertChatMessage(sent); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  const sendVoice = async (blob, seconds, replyTo) => { try { const attachment = await uploadAttachment(blob, 'Voice message', seconds); const { message: sent } = await request('/messages', { method: 'POST', body: JSON.stringify({ receiverId: activeChat, attachments: [attachment.id], replyTo }) }); upsertChatMessage(sent); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  const editChat = async (item, text) => { try { const { message: updated } = await request(`/messages/${item.id}`, { method: 'PATCH', body: JSON.stringify({ text }) }); upsertChatMessage(updated); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  const deleteChat = async (item) => { try { const { message: updated } = await request(`/messages/${item.id}`, { method: 'DELETE' }); upsertChatMessage(updated); loadConversations(); } catch (error) { setMessage(error.message); } };
  const reactChat = async (item, emoji) => { try { const { message: updated } = await request(`/messages/${item.id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }); upsertChatMessage(updated); } catch (error) { setMessage(error.message); } };
  const forwardChat = async (item, receiverIds) => { try { const { messages: sent } = await request('/messages/forward', { method: 'POST', body: JSON.stringify({ messageId: item.id, receiverIds }) }); sent.filter((entry) => chatKey(entry) === activeChat).forEach(upsertChatMessage); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  // "typing…" is sent at most every 2.5 s while the box changes.
  const sendTyping = (to) => { const now = Date.now(); if (!to || now - lastTypingSent.current < 2500) return; lastTypingSent.current = now; socketRef.current?.emit('typing', to); };
  const chatActions = { send: sendChat, sendVoice, edit: editChat, remove: deleteChat, react: reactChat, forward: forwardChat, typing: sendTyping };
  useEffect(() => {
    if (!token) return undefined;
    const socket = io(API_ORIGIN, { auth: { token } });
    socketRef.current = socket;
    socket.on('data:changed', () => refreshSoon());
    socket.on('connect', () => { if (Date.now() - lastRefreshRef.current > 10000) refreshSoon(500); loadConversations(); socket.emit('client-state', { visible: document.visibilityState === 'visible', chatWith: openChatRef.current }); });
    socket.on('notification', (alert) => { setAlerts((current) => [alert, ...current.filter((item) => item.id !== alert.id)].slice(0, 50)); if (document.visibilityState === 'visible') { setToasts((current) => [...current.slice(-2), alert]); setTimeout(() => setToasts((current) => current.filter((item) => item.id !== alert.id)), 5500); if (notifyPrefsRef.current?.sound !== false) playChime(); } });
    socket.on('notifications:read', ({ ids }) => setAlerts((current) => current.map((item) => ids.includes(item.id) ? { ...item, readAt: item.readAt || new Date().toISOString() } : item)));
    socket.on('new-message', (incoming) => {
      const open = openChatRef.current;
      const key = chatKey(incoming);
      setTypingIds((current) => current.filter((id) => id !== key));
      if (open && key === open) setChatMessages((current) => current.some((item) => item.id === incoming.id) ? current : [...current, incoming]);
      if (open && key === open && incoming.senderId !== meRef.current) markRead(open); else loadConversations();
    });
    socket.on('messages:read', loadConversations);
    socket.on('message-updated', (updated) => { const open = openChatRef.current; if (open && chatKey(updated) === open) setChatMessages((current) => current.map((item) => item.id === updated.id ? updated : item)); loadConversations(); });
    socket.on('messages:seen', ({ by }) => { if (openChatRef.current === by) setChatMessages((current) => current.map((item) => item.receiverId === by ? { ...item, read: true } : item)); });
    // A group's other members reading or the group changing: refresh the open thread (ticks, notes) and the list.
    socket.on('group:read', ({ groupId }) => { if (openChatRef.current === groupId) request(`/messages/${groupId}`).then((data) => openChatRef.current === groupId && setChatMessages(data.messages || [])).catch(() => {}); });
    socket.on('groups:changed', ({ groupId }) => { loadConversations(); if (openChatRef.current === groupId) request(`/messages/${groupId}`).then((data) => setChatMessages(data.messages || [])).catch(() => { setActiveChat(null); setChatMessages([]); }); });
    socket.on('typing', ({ from, who }) => { if (who) setTypingWho((current) => ({ ...current, [from]: who })); setTypingIds((current) => current.includes(from) ? current : [...current, from]); clearTimeout(typingTimers.current[from]); typingTimers.current[from] = setTimeout(() => setTypingIds((current) => current.filter((id) => id !== from)), 4000); });
    socket.on('presence:update', ({ userId, isOnline }) => setStaff((current) => current.map((person) => person.id === userId ? { ...person, isOnline } : person)));
    // Live-update connection = can the server be reached right now (the header's "No connection").
    socket.on('connect', () => setServerReachable(true));
    socket.on('disconnect', () => setServerReachable(false));
    socket.on('connect_error', () => setServerReachable(false));
    return () => { socket.disconnect(); socketRef.current = null; setServerReachable(true); };
  }, [token]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  // Keep the open report form on this phone: 0.6 s after the last change, at once when the app goes to the background
  // or is closed, and when leaving the form. Nothing is kept until the form differs from how it opened.
  const flushDraft = () => {
    const pending = draftPending.current;
    if (!pending) return;
    draftPending.current = null;
    const savedAt = Date.now();
    saveDraft(pending.key, { ...pending.draft, savedAt }).then(
      () => { if (draftKeyRef.current === pending.key) setDraftNote((note) => ({ ...note, savedAt, failed: false })); },
      () => { if (draftKeyRef.current === pending.key) setDraftNote((note) => ({ ...note, failed: true })); }
    );
  };
  useEffect(() => {
    const key = draftKeyRef.current;
    if (page !== 'new' || !key || JSON.stringify(report) === draftBase.current) return undefined;
    draftPending.current = { key, draft: { report, reportType } };
    const timer = setTimeout(flushDraft, 600);
    return () => clearTimeout(timer);
  }, [report, page]);
  useEffect(() => () => flushDraft(), [page]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flushDraft);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flushDraft); };
  }, []);
  // What the header says about saving. Only "All changes saved" when the server is reachable and the last save went through.
  const saveStatus = !online || !serverReachable ? { tone: 'offline', text: 'No connection', help: 'Reports being filled in are kept on this phone. Send them once the connection is back.' }
    : pendingSaves > 0 ? { tone: 'saving', text: 'Saving…', help: 'Sending your change to HK SYNC.' }
    : saveFailed ? { tone: 'failed', text: 'Not sent', help: 'The last change could not be sent. Try it again.' }
    : { tone: 'ok', text: 'All changes saved', help: 'Everything you changed has reached HK SYNC.' };
  const unreadTotal = [...conversations, ...chatGroups].reduce((sum, item) => sum + item.unread, 0);
  useEffect(() => { if (token && page === 'messages' && activeChat) openChat(activeChat); }, [page]);
  // Tell the server whether the app is on screen and which chat is open (decides pop-up vs in-app alert).
  const unreadAlerts = alerts.filter((item) => !item.readAt).length;
  // Android back button in the installed app: close whatever is open, step back to the Overview, and from there put the app in the background.
  const backRef = useRef(null);
  backRef.current = () => {
    if (taskDraft) return setTaskDraft(null);
    if (askFor) return setAskFor(null);
    if (taskView) return setTaskView(null);
    if (page === 'messages' && activeChat) return openChat(null);
    if (page === 'report') return setPage(reportView?.returnTo || 'reports');
    if (page === 'profile') return setPage(profile?.returnTo || 'people');
    if (page !== 'overview') { setPage('overview'); window.scrollTo(0, 0); return; }
    NativeApp.minimizeApp();
  };
  useEffect(() => { if (!Capacitor.isNativePlatform()) return undefined; const listener = NativeApp.addListener('backButton', () => backRef.current?.()); return () => { listener.then((handle) => handle.remove()); }; }, []);
  useEffect(() => { const report = () => socketRef.current?.emit('client-state', { visible: document.visibilityState === 'visible', chatWith: page === 'messages' ? activeChat : null }); const hide = () => socketRef.current?.emit('client-state', { visible: false, chatWith: null }); report(); const beat = setInterval(() => { if (document.visibilityState === 'visible') report(); }, 20000); document.addEventListener('visibilitychange', report); window.addEventListener('pagehide', hide); document.addEventListener('freeze', hide); return () => { clearInterval(beat); document.removeEventListener('visibilitychange', report); window.removeEventListener('pagehide', hide); document.removeEventListener('freeze', hide); }; }, [page, activeChat, token]);
  // The number on the app icon follows the unread alerts (Android and iPhone home-screen apps).
  useEffect(() => { try { if (!token) navigator.clearAppBadge?.()?.catch?.(() => {}); else if (unreadAlerts) navigator.setAppBadge?.(unreadAlerts)?.catch?.(() => {}); else navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* not supported */ } if (NATIVE_PUSH && token && !unreadAlerts) PushNotifications.removeAllDeliveredNotifications().catch(() => {}); }, [unreadAlerts, token]);
  useEffect(() => { document.title = unreadAlerts ? `(${unreadAlerts}) HK SYNC` : 'HK SYNC'; }, [unreadAlerts]);
  useEffect(() => { if (token) checkPush(); }, [token]);
  // A tapped notification either messages this open window, or opens the app with ?open=<link>.
  useEffect(() => { if (!token) return undefined; const fromUrl = new URLSearchParams(window.location.search).get('open'); if (fromUrl) { try { openLink(JSON.parse(fromUrl)); } catch { /* ignore a malformed link */ } window.history.replaceState(null, '', window.location.pathname); } if (!('serviceWorker' in navigator)) return undefined; const onMessage = (event) => { if (event.data?.type === 'open-link') openLink(event.data.link); }; navigator.serviceWorker.addEventListener('message', onMessage); return () => navigator.serviceWorker.removeEventListener('message', onMessage); }, [token]);
  useEffect(() => { if (!token || !NATIVE_PUSH) return undefined; let live = true; const handles = [PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => { try { openLink(JSON.parse(notification.data?.link || 'null')); } catch { /* ignore a malformed link */ } }), NativeApp.addListener('resume', () => { if (live) checkPush(); })]; return () => { live = false; handles.forEach((handle) => handle.then((value) => value.remove()).catch(() => {})); }; }, [token]);
  const signIn = async (event) => { event.preventDefault(); setLoginNotice(''); try { const data = await request('/auth/login', { method: 'POST', body: JSON.stringify(login) }); setLogin((current) => ({ ...current, password: '' })); setToken(data.token); setUser(data.user); localStorage.setItem('bahari-token', data.token); localStorage.setItem('bahari-user', JSON.stringify(data.user)); /* A new sign-in is asked about notifications again (a 'Not now' belonged to the previous one). */ localStorage.removeItem('hk-push-banner'); setBannerHidden(false); } catch (error) { setMessage(error.message); } };
  const forgotPassword = async (email) => { const result = await request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }); return result.resetToken ? `${result.message} (Development only: open ${window.location.origin}/?reset=${result.resetToken})` : result.message; };
  const completeReset = async (password) => { const result = await request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password }) }); window.history.replaceState(null, '', window.location.pathname); setResetToken(''); signOut(); setMessage(''); setLoginNotice(result.message); };
  const signOut = () => { const signedOutToken = token; window.history.replaceState(null, '', '/'); if (NATIVE_PUSH) nativePushToken().then((value) => fetch(`${API}/push/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signedOutToken}` }, body: JSON.stringify({ token: value }) })).catch(() => {}); pushSubscription().then((subscription) => { if (!subscription) return; fetch(`${API}/push/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signedOutToken}` }, body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {}).finally(() => subscription.unsubscribe().catch(() => {})); }).catch(() => {}); localStorage.removeItem('bahari-token'); localStorage.removeItem('bahari-user'); setToken(''); setUser(null);
    // A shared phone must not show the next person anything of the last one: notices (a manager's reset link), open pages or cached data.
    setMessage(''); setPage('overview'); setReportView(null); setTaskView(null); setProfile(null); setActiveChat(null); setChatMessages([]); setTaskDraft(null); setAskFor(null); setReports([]); setTasks([]); setStaff([]); setConversations([]); setGoals(null); setPerformance(null); setAlerts([]); setToasts([]); setNotifyPrefs(null); setFilters({ type: '', search: '', date: '' }); goalsYearRef.current = null; };
  const allowedTypes = typesForRole(user?.role);
  const [editing, setEditing] = useState(null);
  const blankReport = (type) => ({ date: localToday(), area: '', block: '', vehicleId: '', supervisorId: '', entries: [emptyEntry(type)], trolleys: type === 'trolley_pantry' ? [emptyEntry(type)] : [], pantries: type === 'trolley_pantry' ? [emptyEntry(type)] : [], needsManager: false, managerTopic: '', managerNote: '', handoverFrom: '', receivedBy: '', emergencyRoomsReady: '', vipRooms: '', repeaterRooms: '', roomsToCheck: '', roomsToClean: '', showerRooms: '', turndownRooms: '', extraTasks: '', notes: '' });
  // Opens a report form; a draft left in that slot (unsent report, or unsaved edit newer than the report) is put back.
const openForm = (key, form, newerThan = 0) => { flushDraft(); draftKeyRef.current = key; draftBase.current = JSON.stringify(form); setReport(form); setDraftNote(null); loadDraft(key).then((draft) => { if (draftKeyRef.current !== key || !draft?.report) return; if (draft.savedAt <= newerThan) { dropDraft(key); return; } setReport(draft.report); setDraftNote({ restoredAt: draft.savedAt, savedAt: draft.savedAt }); }); };
const chooseType = (type) => { if (!allowedTypes.includes(type)) return; setEditing(null); setReportType(type); openForm(draftKey(user.id, type), blankReport(type)); setPage('new'); };
  // Reopen a saved report in its form. Type and date stay as they were; photos are kept unless replaced.
  const startEdit = async (saved) => { try { const { report: full } = await request(`/reports/${saved.id}`); const base = blankReport(full.type); const data = JSON.parse(JSON.stringify(full.data || {})); setReportType(full.type); openForm(draftKey(user.id, full.type, full.id), { ...base, ...data, date: full.date, entries: data.entries?.length ? data.entries : base.entries, trolleys: data.trolleys?.length ? data.trolleys : base.trolleys, pantries: data.pantries?.length ? data.pantries : base.pantries }, Date.parse(full.updatedAt || full.createdAt) || 0); setEditing({ id: full.id, returnTo: reportView?.returnTo || 'reports' }); setPage('new'); window.scrollTo(0, 0); } catch (error) { setMessage(error.message); } };
  // Sent, or thrown away on purpose: the draft goes too.
const closeDraft = () => { dropDraft(draftKeyRef.current); draftKeyRef.current = null; draftPending.current = null; setDraftNote(null); };
const cancelEdit = () => { closeDraft(); stopEdit(); };
const startOver = () => { const key = draftKeyRef.current; const edited = editing; draftKeyRef.current = null; dropDraft(key).then(() => (edited ? startEdit({ id: edited.id }) : chooseType(reportType))); };
const stopEdit = () => { const back = editing; setEditing(null); if (back) { setReportView({ id: back.id, line: null, returnTo: back.returnTo }); setPage('report'); } else setPage('overview'); };
  // `value` may be a function of the current value, for changes that land later (a photo finishing shrinking).
const editReport = (key, value) => setReport((current) => ({ ...current, [key]: typeof value === 'function' ? value(current[key]) : value }));
  const editEntry = (index, key, value) => setReport((current) => ({ ...current, entries: current.entries.map((entry, i) => i === index ? { ...entry, [key]: value } : entry) }));
  const editScore = (index, key, value) => setReport((current) => ({ ...current, entries: current.entries.map((entry, i) => i === index ? { ...entry, scores: { ...entry.scores, [key]: value } } : entry) }));
  const saveReport = async (event) => { event.preventDefault(); try { const data = JSON.parse(JSON.stringify(report)); if (reportType !== 'inspection_rate') delete data.supervisorId; if (reportType !== 'handover') { delete data.receivedById; delete data.needsManager; } if (reportType !== 'trolley_pantry') { delete data.trolleys; delete data.pantries; } if (['trolley_pantry', 'vehicle', 'handover'].includes(reportType)) delete data.entries; if (editing) { await request(`/reports/${editing.id}`, { method: 'PUT', body: JSON.stringify({ data }) }); closeDraft(); setMessage('Changes saved.'); await refresh(); stopEdit(); return; } await request('/reports', { method: 'POST', body: JSON.stringify({ type: reportType, date: report.date, data }) }); closeDraft(); setMessage('Report saved with photos and synced.'); await refresh(); setPage('reports'); } catch (error) { setMessage(error.offline ? `No connection, so the ${editing ? 'changes were' : 'report was'} not sent. ${draftKeyRef.current ? "It's kept on this phone: press Save again once you're back online." : ''}` : error.message); } };
  const saveTask = async (event) => { event.preventDefault(); try { await request('/tasks', { method: 'POST', body: JSON.stringify(taskDraft) }); setTaskDraft(null); setMessage('Task dispatched.'); refresh(); } catch (error) { setMessage(error.message); } };
  const createStaff = async (event) => { event.preventDefault(); try { await request('/users/staff', { method: 'POST', body: JSON.stringify(staffForm) }); setStaffForm({ name: '', email: '', password: '', role: 'supervisor' }); setMessage('Staff account created.'); refresh(); } catch (error) { setMessage(error.message); } };
  const finishExport = async (blob, name, label) => { try { const uri = await saveFile(blob, name); setMessage(uri ? `${label} export saved to ${SAVED_FOLDER}.` : `${label} export downloaded.`); if (uri) await openNativeFile(blob, name, blob.type, uri); } catch (error) { setMessage(`Could not save the ${label} export: ${error.message}`); } };
  const exportVehicleChecks = async (list, period) => { setMessage('Preparing Excel export…'); const { utils, write } = await import('xlsx'); const rows = [...list].sort((a, b) => a.date.localeCompare(b.date)).map((item) => ({ Date: item.date, Vehicle: item.data?.vehicleId || '', Driver: item.submitter?.name || '', Result: vehicleProblems(item).length ? `${vehicleProblems(item).length} Not OK` : 'All OK', ...Object.fromEntries(VEHICLE.flatMap((key) => [[key, vehicleItemState(item, key)], [`${key} remark`, item.data?.vehicleRemarks?.[key] || '']])), OtherNotes: item.data?.notes || '' })); const workbook = utils.book_new(); utils.book_append_sheet(workbook, utils.json_to_sheet(rows), 'Vehicle checks'); await finishExport(new Blob([write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `hk-sync-vehicle-checks-${period}.xlsx`, 'Excel'); };
const exportExcel = async () => { setMessage('Preparing Excel export…'); const { utils, write } = await import('xlsx'); const rows = filteredReports.map((item) => ({ Report: TYPES[item.type], SubmittedBy: item.submitter?.name || '', Date: item.date, Result: item.flagged ? 'Needs attention' : 'Clear', AverageScore: item.average || '', LineItems: item.itemCount || 0, HODSigned: item.hodSignedAt ? 'Yes' : 'No' })); const workbook = utils.book_new(); utils.book_append_sheet(workbook, utils.json_to_sheet(rows), 'Reports'); await finishExport(new Blob([write(workbook, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `hk-sync-reports-${localToday()}.xlsx`, 'Excel'); };
  const exportPdf = async () => { setMessage('Preparing PDF export…'); const { jsPDF } = await import('jspdf'); const pdf = new jsPDF(); pdf.setFontSize(18); pdf.text('HK-SYNC', 14, 18); pdf.setFontSize(12); pdf.text('Operations report register', 14, 27); pdf.setFontSize(9); pdf.text(`Exported ${localToday()} · ${filteredReports.length} reports`, 14, 35); let y = 47; filteredReports.forEach((item, index) => { if (y > 275) { pdf.addPage(); y = 18; } pdf.setFontSize(10); pdf.text(`${index + 1}. ${TYPES[item.type]} | ${item.date}`, 14, y); pdf.setFontSize(8); pdf.text(`Submitted by: ${item.submitter?.name || 'Unknown'} | Score: ${item.average || '—'}/10 | Result: ${item.flagged ? 'Needs attention' : 'Clear'}`, 20, y + 6); y += 16; }); await finishExport(pdf.output('blob'), `hk-sync-reports-${localToday()}.pdf`, 'PDF'); };
  const reportTab = ['handovers', 'vehicles'].includes(filters.tab) ? filters.tab : user?.role === 'driver' ? 'vehicles' : 'reports'; const filteredReports = useMemo(() => reports.filter((item) => (filters.focus ? focusMatch(item, filters.focus) : reportKind(item) === reportTab) && (!filters.type || item.type === filters.type) && (!filters.date || item.date === filters.date) && filters.search.toLowerCase().split(/\s+/).filter(Boolean).every((word) => `${item.submitter?.name} ${TYPES[item.type]} ${item.data?.receivedBy || ''}`.toLowerCase().includes(word))), [reports, filters, reportTab]);
  const reportTabCounts = useMemo(() => ({ reports: reports.filter((item) => reportKind(item) === 'reports').length, vehicles: reports.filter((item) => item.type === 'vehicle').length, handovers: reports.filter((item) => item.type === 'handover').length }), [reports]); const vehicleReports = useMemo(() => reports.filter((item) => item.type === 'vehicle'), [reports]);
  const toggleActive = async (account) => { try { await request(`/users/${account.id}/status`, { method: 'PATCH', body: JSON.stringify({ active: account.active === false }) }); setMessage(`Account ${account.active === false ? 'activated' : 'deactivated'}.`); refresh(); } catch (error) { setMessage(error.message); } };
  const resetPassword = async (account) => { try { const result = await request(`/users/${account.id}/reset-password`, { method: 'POST' }); const copied = await navigator.clipboard?.writeText(result.resetLink).then(() => true, () => false); setMessage(`${result.emailed ? `Reset link emailed to ${account.email}. ` : ''}Reset link for ${account.name} (valid 24 hours${copied ? ', copied to clipboard' : ''}): ${result.resetLink}`); } catch (error) { setMessage(error.message); } };
  const deleteTask = async (task) => { if (!(await confirmAction({ title: `Delete the task "${task.title}"?`, body: task.assignedTo && task.status !== 'completed' ? 'The person it is assigned to will be told it was cancelled.' : '', confirmLabel: 'Delete task', danger: true }))) return false; try { await request(`/tasks/${task.id}`, { method: 'DELETE' }); await refresh(); setMessage('Task deleted.'); return true; } catch (error) { setMessage(error.message); return false; } };
  const updateTaskStatus = async (id, status) => { try { await request(`/tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); refresh(); } catch (error) { setMessage(error.message); } };
  const changePassword = async (form) => { if (form.newPassword !== form.confirmPassword) { setMessage('New passwords do not match.'); return false; } try { const result = await request('/users/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) }); if (result.token) { setToken(result.token); localStorage.setItem('bahari-token', result.token); } setMessage(result.message); return true; } catch (error) { setMessage(error.message); return false; } };
  // Saves one section; optimistic, rolled back if the server refuses.
  // Reports and tasks open in place (from the register, task board, profiles or a chat card); Back returns to where you were.
  const openReport = (id, line = null) => { setReportView({ id, line, returnTo: page === 'report' ? reportView?.returnTo || 'reports' : page }); setPage('report'); window.scrollTo(0, 0); };
  const openShare = (share) => (share.kind === 'report' ? openReport(share.id, share.line || null) : setTaskView(share.id));
  const openDiscussion = (userId) => { setTaskView(null); setPage('messages'); openChat(userId); };
  const askAbout = (details) => setAskFor(details);
  const sendAsk = async ({ receiverId, text, share }) => { try { await request('/messages', { method: 'POST', body: JSON.stringify({ receiverId, text, share }) }); setAskFor(null); setAskVersion((value) => value + 1); setMessage(`Sent to ${staff.find((person) => person.id === receiverId)?.name || 'them'}. Their reply will appear in Messages.`); refresh(); loadConversations(); return true; } catch (error) { setMessage(error.message); return false; } };
  // Where a notification leads: the chat, the task or the report it is about.
  const openLink = (link) => { if (!link) return; if (link.page === 'messages' && (link.groupId || link.userId)) { setPage('messages'); openChat(link.groupId || link.userId); } else if (link.page === 'task' && link.id) setTaskView(link.id); else if (link.page === 'report' && link.id) openReport(link.id); else if (link.page) setPage(link.page); };
  const markAlertsRead = async (ids) => { setAlerts((current) => current.map((item) => (!ids || ids.includes(item.id)) && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item)); try { await request('/notifications/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : { all: true }) }); } catch { /* the next refresh corrects it */ } };
  const openAlert = (alert) => { if (!alert.readAt) markAlertsRead([alert.id]); openLink(alert.link); };
  const dismissToast = (id) => setToasts((current) => current.filter((item) => item.id !== id));
  // This device's notification status: on, off, blocked, needs Home Screen (iPhone), or not supported.
  const checkPush = async () => { if (NATIVE_PUSH) { try { const { receive } = await PushNotifications.checkPermissions(); if (receive === 'denied') setPushState('denied'); else if (localStorage.getItem('hk-native-push') === 'off') setPushState(receive === 'granted' ? 'off' : 'default'); else await enablePush({ quiet: true }); } catch { setPushState('unsupported'); } return; } if (!PUSH_SUPPORTED) { setPushState(IS_IOS && !IS_STANDALONE ? 'ios-install' : 'unsupported'); return; } if (Notification.permission === 'denied') { setPushState('denied'); return; } const subscription = await pushSubscription(); if (subscription && Notification.permission === 'granted') { setPushState('on'); request('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) }).catch(() => {}); } else if (Notification.permission === 'granted') { /* This phone allows HK-SYNC alerts but has no registration (signing out removes it): register again for whoever is signed in now. */ if (!(await enablePush({ quiet: true }))) setPushState('off'); } else setPushState('default'); };
  const enablePush = async ({ quiet = false } = {}) => { try { if (NATIVE_PUSH) { const push = PushNotifications; let { receive } = await push.checkPermissions(); if (receive === 'prompt' || (receive === 'prompt-with-rationale' && !quiet)) ({ receive } = await push.requestPermissions()); if (receive !== 'granted') { setPushState(receive === 'denied' ? 'denied' : 'default'); return false; } await push.createChannel(ALERT_CHANNEL); await request('/push/subscribe', { method: 'POST', body: JSON.stringify({ native: { token: await nativePushToken(), platform: 'android' } }) }); localStorage.setItem('hk-native-push', 'on'); setPushState('on'); return true; } const permission = await Notification.requestPermission(); if (permission !== 'granted') { setPushState(permission === 'denied' ? 'denied' : 'default'); return false; } const registration = await navigator.serviceWorker.getRegistration() || await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]); if (!registration) { if (!quiet) setMessage('Notifications need the installed app (they work on the live site, not in development).'); return false; } const { publicKey } = await request('/push/key'); const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) }); await request('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) }); setPushState('on'); return true; } catch (error) { if (!quiet) setMessage(`Could not turn on notifications: ${error.message}`); else if (NATIVE_PUSH) setPushState('off'); return false; } };
  const disablePush = async () => { if (NATIVE_PUSH) { localStorage.setItem('hk-native-push', 'off'); try { await request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ token: await nativePushToken() }) }); } catch { /* the server forgets it on its own when sending fails */ } setPushState('off'); return; } const subscription = await pushSubscription(); if (subscription) { await request('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {}); await subscription.unsubscribe().catch(() => {}); } setPushState(Notification.permission === 'granted' ? 'off' : 'default'); };
  const testPush = async () => { try { const device = NATIVE_PUSH ? { token: await nativePushToken() } : { endpoint: (await pushSubscription())?.endpoint }; await request('/push/test', { method: 'POST', body: JSON.stringify(device) }); setMessage('Test notification sent. It should appear in a few seconds.'); } catch (error) { setMessage(error.message); } };
  const saveNotifyPrefs = async (changes) => { setNotifyPrefs((current) => ({ ...current, ...changes, categories: { ...current.categories, ...(changes.categories || {}) }, quietHours: { ...current.quietHours, ...(changes.quietHours || {}) } })); try { setNotifyPrefs((await request('/users/me/notify', { method: 'PUT', body: JSON.stringify(changes) })).settings); } catch (error) { setMessage(error.message); } };
  const hideBanner = () => { setBannerHidden(true); try { localStorage.setItem('hk-push-banner', 'hidden'); } catch { /* per-device convenience */ } };
  // Reports page opened from the Overview: a date, a type, or a focus such as "Needs attention" or one person's reports.
const openReports = ({ date = '', type = '', focus = null } = {}) => { setFilters({ tab: 'reports', type, search: '', date, focus }); setPage('reports'); window.scrollTo(0, 0); };
const openProfile = (name) => { setProfile({ name, returnTo: page }); setPage('profile'); window.scrollTo(0, 0); };
  const openSupervisor = (id, name) => { setProfile({ kind: 'supervisor', id, name, returnTo: page }); setPage('profile'); window.scrollTo(0, 0); };
  const showGoalsYear = async (year) => { try { const result = await request(`/goals?year=${year}`); goalsYearRef.current = result.goals.current ? null : result.goals.startYear; setGoals(result.goals); } catch (error) { setMessage(error.message); } };
  const saveGoals = async (section, rows, extra = {}) => { if (goals?.current === false) { setMessage('This is a past year. Switch back to the current year to change targets or the roster.'); return; } const problem = section === 'hkProgress' && rosterProblem(rows); if (problem) { setMessage(problem); return false; } const previous = goals; setGoals((current) => ({ ...current, [section]: rows })); try { const result = await request('/goals', { method: 'PUT', body: JSON.stringify({ [section]: rows, ...extra }) }); setGoals(result.goals); setMessage(result.renamedLines ? `Goals saved. Updated ${plural(result.renamedLines, 'past report line')} to the new name.` : 'Goals saved.'); if (result.renamedLines) refresh(); return true; } catch (error) { setGoals(previous); setMessage(error.message); return false; } };
  const signReport = async (id) => { try { await request(`/reports/${id}/sign`, { method: 'POST' }); refresh(); } catch (error) { setMessage(error.message); } };
  const pageTitle = page === 'overview' ? 'Overview' :page === 'new' ? TYPES[reportType] : page === 'people' ? 'People & performance' : page === 'goals' ? 'Goals & points' : page === 'profile' ? (profile?.kind === 'supervisor' ? 'Supervisor profile' : 'Housekeeper profile') : page === 'report' ? 'Report' : page[0].toUpperCase() + page.slice(1);
  // ---------- Page addresses (lib/routes.js) ----------
  // Once signed in, finish opening the address the app started at: a chat's messages, a new report form, a report to edit.
  const routeStarted = useRef(false);
  useEffect(() => {
    if (!token || !user || routeStarted.current) return;
    routeStarted.current = true;
    if (startRoute.chatId) openChat(startRoute.chatId);
    if (startRoute.newType) chooseType(startRoute.newType);
    if (startRoute.editId) startEdit({ id: startRoute.editId });
  }, [token, user?.id]);
  // Manager pages opened by someone else (an old link, a shared address) fall back to the Overview.
  useEffect(() => { if (user && !isManager && MANAGER_PAGES.includes(page)) setPage('overview'); }, [page, user?.role]);
  // Write the screen into the address bar: each new screen is a step Back can return to. The first write after signing
  // in replaces (the address may need tidying); switching type inside a new report form replaces too.
  const addressWritten = useRef(false);
  useEffect(() => {
    if (!token) return;
    const path = routePath({ page, reportView, profile, activeChat, taskView, reportType, editing });
    const current = `${window.location.pathname}${window.location.search}`;
    const replace = !addressWritten.current || (path.startsWith('/reports/new/') && current.startsWith('/reports/new/'));
    addressWritten.current = true;
    if (path !== current) window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
  }, [token, page, reportView?.id, profile?.name, profile?.id, activeChat, taskView, reportType, editing?.id]);
  // Back / Forward in the browser: show the screen the address names.
  const showRoute = useRef(null);
  showRoute.current = (route) => {
    setTaskView(route.taskId); setTaskDraft(null); setAskFor(null);
    if (route.page === 'new') {
      if (route.editId && editing?.id !== route.editId) startEdit({ id: route.editId });
      else if (route.newType && (page !== 'new' || editing || reportType !== route.newType)) chooseType(route.newType);
      return;
    }
    if (route.page === 'report') setReportView((current) => (current?.id === route.reportId ? current : { id: route.reportId, line: null, returnTo: 'reports' }));
    if (route.page === 'profile') setProfile(route.profile);
    if (route.page === 'messages' && route.chatId !== activeChat) openChat(route.chatId);
    setPage(route.page);
    window.scrollTo(0, 0);
  };
  useEffect(() => { const onPop = () => showRoute.current(parseRoute(window.location)); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  useEffect(() => { document.title = token && pageTitle ? `${pageTitle} · HK SYNC` : 'HK SYNC'; }, [pageTitle, token]);
  if (resetToken) return <ResetPassword submit={completeReset} cancel={() => { window.history.replaceState(null, '', window.location.pathname); setResetToken(''); }} />;
  if (!token) return <Login login={login} setLogin={setLogin} signIn={signIn} message={message} notice={loginNotice} forgotPassword={forgotPassword} emailReset={emailReset} clearMessages={() => { setMessage(''); setLoginNotice(''); }} />;
  return <div className="app"><aside className="rail"><div className="property-mark" role="img" aria-label="HK SYNC" /><nav>{[['overview', 'Overview', '⌂'], ['reports', 'Reports', '▤'], ['tasks', 'Tasks', '✓'], ['messages', 'Messages', '✉'], ...(isManager ? [['people', 'People', '↗'], ['goals', 'Goals', '◎']] : []), ['account', 'Account', '⚙']].map(([key, label, icon]) => <button className={page === key ? 'active' : ''} onClick={() => { setMessage(''); setPage(key); window.scrollTo(0, 0); }} key={key}><b>{icon}</b>{label}{key === 'messages' && unreadTotal > 0 && <i className="nav-badge" aria-label={`${unreadTotal} unread`}>{unreadTotal > 99 ? '99+' : unreadTotal}</i>}</button>)}</nav><button className="logout" onClick={signOut} aria-label="Log out" title="Log out"><b>↪</b><span>Log out</span></button></aside><div className="content"><header><div><p className="kicker">HK-SYNC</p><h1>{pageTitle}</h1></div><div className="header-tools"><Bell alerts={alerts} unread={unreadAlerts} open={openAlert} markAll={() => markAlertsRead(null)} /><div className="sync"><span className={`save-status ${saveStatus.tone}`} role="status" title={saveStatus.help}><i />{saveStatus.text}</span><span className="avatar">{user.name.slice(0, 2).toUpperCase()}</span></div></div></header><main>{!bannerHidden && ['default', 'ios-install'].includes(pushState) && <PushBanner state={pushState} enable={async () => { if (await enablePush()) hideBanner(); }} hide={hideBanner} />}{message && <div className="notice">{message}<button onClick={() => setMessage('')}>×</button></div>}{page === 'overview' && user.role === 'driver' && <DriverHome reports={vehicleReports} me={user} openReport={openReport} newChecklist={() => chooseType('vehicle')} exportChecks={(list, period) => exportVehicleChecks(list, period).catch((error) => setMessage(`Excel export failed: ${error.message}`))} />}{page === 'overview' && user.role !== 'driver' && <Overview reports={reports} tasks={tasks} goals={goals} staff={staff} openReport={openReport} chooseType={chooseType} allowedTypes={allowedTypes} isManager={isManager} setPage={setPage} performance={performance} openProfile={openProfile} openSupervisor={openSupervisor} userId={user.id} newTask={setTaskDraft} openReports={openReports} openTask={setTaskView} />}{page === 'reports' && <Reports reports={filteredReports} tabCounts={reportTabCounts} vehicleReports={vehicleReports} exportVehicleChecks={(list, period) => exportVehicleChecks(list, period).catch((error) => setMessage(`Excel export failed: ${error.message}`))} me={user} staff={staff} openReport={openReport} ask={askAbout} openDiscussion={openDiscussion} filters={{ ...filters, tab: reportTab }} setFilters={setFilters} isManager={isManager} setTaskDraft={setTaskDraft} sign={signReport} exportExcel={() => exportExcel().catch((error) => setMessage(`Excel export failed: ${error.message}`))} exportPdf={() => exportPdf().catch((error) => setMessage(`PDF export failed: ${error.message}`))} />}{page === 'tasks' && <Tasks tasks={tasks} staff={staff} isManager={isManager} userId={user.id} role={user.role} setTaskDraft={setTaskDraft} updateStatus={updateTaskStatus} ask={askAbout} openDiscussion={openDiscussion} remove={deleteTask} />}{page === 'account' && <><Account user={user} changePassword={changePassword} signOut={signOut} />{notifyPrefs && <NotificationSettings prefs={notifyPrefs} save={saveNotifyPrefs} isManager={isManager} pushState={pushState} enable={enablePush} disable={disablePush} test={testPush} />}{user.role === 'manager' && <Backups request={request} />}</>}{page === 'goals' && isManager && (goals ? <Goals goals={goals} save={saveGoals} reports={reports} openProfile={openProfile} openSupervisor={openSupervisor} showYear={showGoalsYear} /> : <Empty text="Loading goals…" />)}{page === 'profile' && isManager && profile && (profile.kind === 'supervisor' ? <SupervisorProfile key={profile.id} id={profile.id} name={profile.name} request={request} openReport={openReport} back={() => setPage(profile.returnTo || 'people')} /> : <HkProfile key={profile.name} name={profile.name} request={request} openReport={openReport} newTask={setTaskDraft} back={() => setPage(profile.returnTo || 'people')} />)}{page === 'report' && reportView && <ReportDetail key={`${reportView.id}-${reportView.line?.list}-${reportView.line?.index}`} view={reportView} version={askVersion} me={user} staff={staff} request={request} back={() => setPage(reportView.returnTo || 'reports')} sign={signReport} newTask={setTaskDraft} ask={askAbout} openDiscussion={openDiscussion} onEdit={startEdit} onDeleted={async () => { setPage(reportView.returnTo === 'report' ? 'reports' : reportView.returnTo || 'reports'); await refresh(); setMessage('Report deleted.'); }} />}<datalist id="hk-roster">{hkRoster.map((name) => <option value={name} key={name} />)}</datalist>{page === 'messages' && <Messages me={user} staff={staff} conversations={conversations} groups={chatGroups} groupActions={groupActions} typingWho={typingWho} activeChat={activeChat} openChat={openChat} messages={chatMessages} actions={chatActions} typingIds={typingIds} onOpenShare={openShare} />}{page === 'people' && isManager && <><SupervisorProfileList request={request} openSupervisor={openSupervisor} /><ProfileList request={request} openProfile={openProfile} /><StaffAccounts viewerRole={user.role} staff={staff} form={staffForm} setForm={setStaffForm} submit={createStaff} toggleActive={toggleActive} resetPassword={resetPassword} /></>}{page === 'new' && draftNote && <div className={`draft-note ${draftNote.failed ? 'failed' : ''}`} role="status">{draftNote.failed ? "This phone couldn't keep a draft. Send the report before closing the app." : draftNote.restoredAt ? <>Restored your unsent {editing ? 'changes' : 'report'} from {draftTime(draftNote.restoredAt)}. Changes keep saving on this phone.<button type="button" onClick={startOver}>Start over</button></> : `Draft saved on this phone · ${draftTime(draftNote.savedAt)}`}</div>}{page === 'new' && <ReportForm type={reportType} me={user} report={report} editReport={editReport} editEntry={editEntry} editScore={editScore} addEntry={() => editReport('entries', [...report.entries, emptyEntry(reportType)])} submit={saveReport} chooseType={chooseType} allowedTypes={allowedTypes} staff={staff} editing={editing} cancelEdit={cancelEdit} roster={hkRoster} />}</main></div><ConfirmHost />{taskDraft && <TaskModal draft={taskDraft} setDraft={setTaskDraft} staff={staff} submit={saveTask} />}{taskView && <TaskView id={taskView} version={askVersion} me={user} staff={staff} request={request} close={() => setTaskView(null)} updateStatus={async (id, status) => { await updateTaskStatus(id, status); }} ask={askAbout} openDiscussion={openDiscussion} remove={deleteTask} />}{askFor && <AskDialog ask={askFor} me={user} staff={staff} close={() => setAskFor(null)} send={sendAsk} />}<div className="toasts" aria-live="polite">{toasts.map((alert) => <button type="button" key={alert.id} className="toast" onClick={() => { dismissToast(alert.id); openAlert(alert); }}><span aria-hidden="true">{NOTIFY_ICONS[alert.type] || '🔔'}</span><span><b>{alert.title}</b>{alert.body && <small>{alert.body}</small>}</span></button>)}</div></div>;
}
