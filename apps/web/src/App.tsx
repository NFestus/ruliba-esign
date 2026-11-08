import { ReactNode } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { PageHead } from './components/ui';
import { ActivatePage, ForgotPasswordPage, ResetPasswordPage } from './pages/Activate';
import { ChangePasswordPage } from './pages/ChangePassword';
import { DashboardPage, DocumentsPage } from './pages/Dashboard';
import { ContactsPage } from './pages/Contacts';
import { DocumentViewPage } from './pages/documents/DocumentView';
import { NewDocumentPage } from './pages/documents/NewDocument';
import { PreparePage } from './pages/documents/Prepare';
import { SignLinkPage, StaffSignPage } from './pages/sign/SignPage';
import { MySignaturePage } from './pages/settings/MySignature';
import { LoginPage } from './pages/Login';
import { ReportsPage } from './pages/Reports';
import { TemplatesPage } from './pages/Templates';
import { VerifyPage, VerifyPanel } from './pages/Verify';
import { SigningPage } from './pages/settings/Signing';
import { StampsPage } from './pages/settings/Stamps';
import { EmailPage } from './pages/settings/Email';
import { SignFrame } from './pages/sign/SignPage';
import { AccountPage } from './pages/settings/Account';
import { ActivityPage } from './pages/settings/Activity';
import { ApprovalsPage } from './pages/settings/Approvals';
import { DepartmentsPage, DocumentTypesPage } from './pages/settings/Organisation';
import { UsersPage } from './pages/settings/Users';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Pages for some roles only. Anyone else lands on the homepage (the server refuses their data as well). */
function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { hasRole } = useAuth();
  if (!hasRole(...roles)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const VIEWERS = ['ADMIN', 'AUDITOR'];

function SettingsLayout() {
  const { hasRole } = useAuth();
  const admin = hasRole('ADMIN');
  const viewer = hasRole('ADMIN', 'AUDITOR');
  return (
    <>
      <PageHead title="Settings" intro="Your own account, and how documents are approved and signed at Ruliba Clays." />
      <nav className="tabs" aria-label="Settings sections">
        <NavLink to="/settings/account">Your account</NavLink>
        <NavLink to="/settings/signature">My signature</NavLink>
        {viewer && <NavLink to="/settings/users">People</NavLink>}
        {admin && <NavLink to="/settings/departments">Departments</NavLink>}
        {admin && <NavLink to="/settings/document-types">Document types</NavLink>}
        {hasRole('ADMIN', 'AUDITOR', 'SENDER', 'APPROVER') && <NavLink to="/settings/approvals">Approvals</NavLink>}
        {admin && <NavLink to="/settings/stamps">Stamps</NavLink>}
        {admin && <NavLink to="/settings/email">Email</NavLink>}
        {viewer && <NavLink to="/settings/signing">Digital seal</NavLink>}
        {viewer && <NavLink to="/settings/activity">Activity log</NavLink>}
      </nav>
      <Outlet />
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate/:token" element={<ActivatePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/sign/:token" element={<SignLinkPage />} />
      <Route
        path="/check"
        element={
          <SignFrame footer="Ruliba Clays Ltd, Kigali, Rwanda. Questions about a document: sign@ruliba.com">
            <h1>Check a document</h1>
            <span className="zigzag" aria-hidden="true" />
            <p style={{ margin: '8px 0 18px' }}>Confirm that a PDF is exactly the copy signed through Ruliba Clays eSign, with nothing changed.</p>
            <VerifyPanel />
          </SignFrame>
        }
      />
      <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/new" element={<NewDocumentPage />} />
        <Route path="/documents/:id" element={<DocumentViewPage />} />
        <Route path="/documents/:id/prepare" element={<PreparePage />} />
        <Route path="/documents/:id/sign" element={<StaffSignPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/reports" element={<RequireRole roles={VIEWERS}><ReportsPage /></RequireRole>} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="account" replace />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="signature" element={<MySignaturePage />} />
          <Route path="users" element={<RequireRole roles={VIEWERS}><UsersPage /></RequireRole>} />
          <Route path="departments" element={<RequireRole roles={['ADMIN']}><DepartmentsPage /></RequireRole>} />
          <Route path="document-types" element={<RequireRole roles={['ADMIN']}><DocumentTypesPage /></RequireRole>} />
          <Route path="approvals" element={<RequireRole roles={['ADMIN', 'AUDITOR', 'SENDER', 'APPROVER']}><ApprovalsPage /></RequireRole>} />
          <Route path="stamps" element={<RequireRole roles={['ADMIN']}><StampsPage /></RequireRole>} />
          <Route path="email" element={<RequireRole roles={['ADMIN']}><EmailPage /></RequireRole>} />
          <Route path="signing" element={<RequireRole roles={VIEWERS}><SigningPage /></RequireRole>} />
          <Route path="activity" element={<RequireRole roles={VIEWERS}><ActivityPage /></RequireRole>} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
