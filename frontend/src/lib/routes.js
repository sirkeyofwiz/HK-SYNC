// Page addresses. The screen on show is written into the address bar (so Back, refresh and shared links work), and an
// address is turned back into a screen. Addresses:
//   /                                   Overview
//   /reports  /tasks  /messages  /people  /goals  /account
//   /reports/<id>                       one report
//   /reports/new/<type>                 a new report of that type
//   /reports/<id>/edit                  editing a report
//   /messages/<user or group id>        a chat
//   /people/housekeepers/<name>         a housekeeper's profile
//   /people/supervisors/<id>            a supervisor's profile
//   …?task=<id>                         a task, open over any page
export const PAGES = ['overview', 'reports', 'tasks', 'messages', 'people', 'goals', 'account'];
// Pages only managers and assistant managers can open.
export const MANAGER_PAGES = ['people', 'goals', 'profile'];

const part = (value) => encodeURIComponent(String(value));

export function routePath({ page, reportView, profile, activeChat, taskView, reportType, editing }) {
  let path = '/';
  if (page === 'report' && reportView?.id) path = `/reports/${part(reportView.id)}`;
  else if (page === 'new') path = editing?.id ? `/reports/${part(editing.id)}/edit` : `/reports/new/${part(reportType)}`;
  else if (page === 'profile' && profile) path = profile.kind === 'supervisor' ? `/people/supervisors/${part(profile.id)}` : `/people/housekeepers/${part(profile.name)}`;
  else if (page === 'messages' && activeChat) path = `/messages/${part(activeChat)}`;
  else if (PAGES.includes(page) && page !== 'overview') path = `/${page}`;
  return taskView ? `${path}?task=${part(taskView)}` : path;
}

// What an address asks for. Anything unknown is the Overview.
export function parseRoute(location) {
  let parts;
  try { parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { parts = []; }
  const [section, id, extra] = parts;
  const route = { page: 'overview', reportId: null, editId: null, newType: null, profile: null, chatId: null, taskId: new URLSearchParams(location.search).get('task') || null };
  if (section === 'reports' && id === 'new' && extra) return { ...route, page: 'new', newType: extra };
  if (section === 'reports' && id && extra === 'edit') return { ...route, page: 'new', editId: id };
  if (section === 'reports' && id) return { ...route, page: 'report', reportId: id };
  if (section === 'messages' && id) return { ...route, page: 'messages', chatId: id };
  if (section === 'people' && id === 'housekeepers' && extra) return { ...route, page: 'profile', profile: { name: extra, returnTo: 'people' } };
  if (section === 'people' && id === 'supervisors' && extra) return { ...route, page: 'profile', profile: { kind: 'supervisor', id: extra, name: '', returnTo: 'people' } };
  if (PAGES.includes(section)) return { ...route, page: section };
  return route;
}
