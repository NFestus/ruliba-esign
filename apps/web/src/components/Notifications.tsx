import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatDate } from './ui';
import { IconBell } from './icons';

interface Note {
  id: string;
  subject: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

/** The bell: what happened to my documents. Checks every minute while the app is open. */
export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ unread: number; items: Note[] }>('/notifications'), refetchInterval: 60_000 });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read', { body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const unread = q.data?.unread ?? 0;
  const toPath = (link: string | null) => {
    if (!link) return null;
    try {
      return new URL(link, window.location.origin).pathname;
    } catch {
      return null;
    }
  };

  return (
    <div className="bell" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
        <IconBell />
        {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="menu notes">
          <div className="menu-head">
            <b>Notifications</b>
            {unread > 0 && (
              <button className="btn-link small" onClick={() => readAll.mutate()}>
                Mark all as read
              </button>
            )}
          </div>
          {q.data?.items.length ? (
            <ul>
              {q.data.items.map((n) => {
                const path = toPath(n.link);
                return (
                  <li key={n.id} className={n.readAt ? '' : 'unread'}>
                    {path ? (
                      <Link to={path} onClick={() => setOpen(false)}>
                        {n.subject}
                        <small>{formatDate(n.createdAt)}</small>
                      </Link>
                    ) : (
                      <a>
                        {n.subject}
                        <small>{formatDate(n.createdAt)}</small>
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted small" style={{ padding: '4px 14px 14px' }}>
              Nothing yet. You will see here when someone signs, approves or declines.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
