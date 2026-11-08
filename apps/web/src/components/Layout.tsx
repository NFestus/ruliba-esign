import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { applyTheme, Theme, useTheme } from '../theme';
import { IconChart, IconCheck, IconFile, IconGear, IconGrid, IconMoon, IconPeople, IconSun, IconTemplate } from './icons';
import { NotificationBell } from './Notifications';
import { useInstall } from '../install';
import { Dialog } from './ui';

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Kigali' }).format(new Date());

export function Layout() {
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const install = useInstall();
  const [installHelp, setInstallHelp] = useState(false);
  const theme = useTheme();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenuOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  if (!user) return null;
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main">
        <Link to="/" className="brand">
          <img src="/logo-192.png" alt="" />
          <span>
            <b>Ruliba Clays</b>
            <small>eSign</small>
          </span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end><IconGrid /> Dashboard</NavLink>
          <NavLink to="/documents"><IconFile /> Documents</NavLink>
          <NavLink to="/templates"><IconTemplate /> Templates</NavLink>
          <NavLink to="/contacts"><IconPeople /> Contacts</NavLink>
          {hasRole('ADMIN', 'AUDITOR') && <NavLink to="/reports"><IconChart /> Reports</NavLink>}
          <NavLink to="/settings"><IconGear /> Settings</NavLink>
        </nav>
        <div className="nav-label">Elsewhere</div>
        <nav className="nav">
          <NavLink to="/verify"><IconCheck /> Check a document</NavLink>
        </nav>
        <p className="sidebar-foot">Ruliba Clays Ltd, Kigali</p>
      </aside>

      <div className="main">
        <header className="topbar">
          <span>{today()}</span>
          <div className="topbar-actions" ref={menuRef}>
            <button className="icon-btn" onClick={() => applyTheme(nextTheme)} aria-label={`Switch to ${nextTheme} theme`}>
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <NotificationBell />
            <button className="avatar" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Your account">
              {initials(user.fullName)}
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <b>{user.fullName}</b>
                  <span>{user.email}</span>
                </div>
                <button role="menuitem" onClick={() => { setMenuOpen(false); navigate('/settings/account'); }}>
                  Your account and security
                </button>
                {install && (
                  <button
                    role="menuitem"
                    onClick={async () => {
                      setMenuOpen(false);
                      if (install.kind === 'prompt') await install.install();
                      else setInstallHelp(true);
                    }}
                  >
                    Install eSign app
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={async () => {
                    // Leave the page first, so the next person to sign in is not sent back to it.
                    navigate('/login', { replace: true, state: null });
                    await logout();
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
        {installHelp && (
          <Dialog title="Install eSign" onClose={() => setInstallHelp(false)}>
            {install?.kind === 'ios' ? (
              <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
                <li>Open eSign in <b>Safari</b>.</li>
                <li>Tap the <b>Share</b> button (the square with an arrow).</li>
                <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
              </ol>
            ) : (
              <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
                <li>
                  <b>Chrome or Edge on a computer:</b> click the install icon at the right end of the address bar, or the menu (⋮), then <b>Install Ruliba Clays eSign</b>.
                </li>
                <li>
                  <b>Android:</b> Chrome menu (⋮), then <b>Install app</b> or <b>Add to Home screen</b>.
                </li>
              </ol>
            )}
            <p className="small muted" style={{ marginTop: 10 }}>eSign then opens in its own window with the Ruliba icon. Documents are never stored on the device.</p>
            <div className="row-end">
              <button className="btn btn-primary" onClick={() => setInstallHelp(false)}>
                OK
              </button>
            </div>
          </Dialog>
        )}
      </div>
    </div>
  );
}
