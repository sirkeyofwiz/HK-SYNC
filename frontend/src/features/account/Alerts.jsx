import { useEffect, useRef, useState } from 'react';
import { timeAgo } from '../../lib/format';
import { NOTIFY_ICONS } from '../../lib/push';
import { Icon } from '../../components/icons';

// ---------- Notification components ----------
export function Bell({ alerts, unread, open, markAll }) { const [showing, setShowing] = useState(false); const ref = useRef(null); useEffect(() => { if (!showing) return undefined; const onDown = (e) => !ref.current?.contains(e.target) && setShowing(false); const onKey = (e) => e.key === 'Escape' && setShowing(false); window.addEventListener('mousedown', onDown); window.addEventListener('keydown', onKey); return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); }; }, [showing]); return <div className="bell" ref={ref}><button type="button" className="bell-button" aria-label={unread ? `${unread} unread notifications` : 'Notifications'} aria-expanded={showing} onClick={() => setShowing((value) => !value)}><Icon name="bell" />{unread > 0 && <i>{unread > 99 ? '99+' : unread}</i>}</button>{showing && <div className="bell-panel" role="dialog" aria-label="Notifications"><div className="bell-head"><b>Notifications</b>{unread > 0 && <button type="button" className="text" onClick={markAll}>Mark all as read</button>}</div><div className="bell-list">{alerts.map((alert) => <button type="button" key={alert.id} className={`bell-item ${alert.readAt ? '' : 'unread'}`} onClick={() => { setShowing(false); open(alert); }}><span className="bell-icon" aria-hidden="true">{NOTIFY_ICONS[alert.type] || '🔔'}</span><span className="bell-text"><b>{alert.title}</b>{alert.body && <small>{alert.body}</small>}</span><small className="bell-time">{timeAgo(alert.createdAt)}</small></button>)}{!alerts.length && <p className="muted bell-empty">No notifications yet. New tasks, questions and messages will appear here.</p>}</div></div>}</div>; }
// Asks once to turn on notifications, as a pop-up a moment after the app opens. "Turn on" brings up the phone's or browser's
// own "Allow notifications?" prompt; "Not now" (or ×) remembers the choice, and Account can turn them on later.
// On an iPhone in Safari it explains Add to Home Screen first, since only the installed app can get notifications.
export function PushBanner({ state, enable, hide }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setReady(true), 1200); return () => clearTimeout(timer); }, []);
  if (!ready) return null;
  const ios = state === 'ios-install';
  return <div className="backdrop push-prompt-backdrop" onClick={hide}><div className="modal push-prompt" role="dialog" aria-modal="true" aria-labelledby="push-prompt-title" onClick={(event) => event.stopPropagation()}>
    <button type="button" className="close" onClick={hide} aria-label="Close">×</button>
    <span className="push-prompt-icon" aria-hidden="true"><Icon name="bell" size={28} /></span>
    <h2 id="push-prompt-title">{ios ? 'Get notifications on your iPhone' : 'Turn on notifications?'}</h2>
    {ios ? <p className="muted">Tap <b>Share</b> then <b>Add to Home Screen</b>, and open HK SYNC from your Home Screen. Then you can allow notifications.</p> : <p className="muted">Get an alert for new tasks, questions and messages — even when HK SYNC is closed.</p>}
    <div className="push-prompt-actions">{ios ? <button type="button" className="primary" onClick={hide}>Got it</button> : <><button type="button" className="secondary" onClick={hide}>Not now</button><button type="button" className="primary" onClick={enable}>Turn on</button></>}</div>
  </div></div>;
}
