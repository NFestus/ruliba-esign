import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { IconPeople, IconSearch } from '../components/icons';
import { Empty, formatDate, PageHead } from '../components/ui';

interface Contact {
  id: string;
  fullName: string;
  email: string;
  company: string | null;
  documentCount: number;
  lastSentAt: string | null;
}

export function ContactsPage() {
  const [q, setQ] = useState('');
  const contacts = useQuery({ queryKey: ['contacts', q], queryFn: () => api<Contact[]>(`/contacts?q=${encodeURIComponent(q.trim())}`) });
  return (
    <>
      <PageHead title="Contacts" intro="Everyone outside Ruliba you have sent documents to. Start typing a name on the Signers step and they are offered." />
      <section className="panel">
        <div className="filters">
          <span className="muted small">
            {contacts.data?.length ?? 0} {contacts.data?.length === 1 ? 'contact' : 'contacts'}
          </span>
          <label className="search">
            <span className="sr-only">Search contacts</span>
            <IconSearch />
            <input className="input" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
        {contacts.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Documents</th>
                <th>Last sent</th>
              </tr>
            </thead>
            <tbody>
              {contacts.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.fullName}</b>
                    {c.company && <div className="sub">{c.company}</div>}
                  </td>
                  <td>{c.email}</td>
                  <td>{c.documentCount}</td>
                  <td className="small">{formatDate(c.lastSentAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<IconPeople width={28} height={28} />} title={q ? `No one matches “${q}”.` : 'No contacts yet.'}>
            <p>People outside Ruliba are added here the first time you send them a document.</p>
          </Empty>
        )}
      </section>
    </>
  );
}
