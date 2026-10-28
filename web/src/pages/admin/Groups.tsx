import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Spinner } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useAdminMe } from './AdminLayout';

export interface Group {
  id: string;
  name: string;
  description: string;
  why: string;
  icon: string;
  segment: Record<string, unknown>;
  idea: { name: string; message: string };
  members: number;
  reachable: number;
}

export default function Groups() {
  const me = useAdminMe();
  const [groups, setGroups] = useState<Group[] | null>(null);
  useEffect(() => {
    api('/api/admin/groups').then(setGroups);
  }, []);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Groups</h1>
          <p>Ready-made groups that update themselves. Message a group, look through its members, or download the list.</p>
        </div>
      </div>
      {!groups ? <Spinner /> : (
        <div className="groups">
          {groups.map((g) => (
            <div key={g.id} className="group-card">
              <div className="group-top">
                <span className="group-icon"><Icon name={g.icon} /></span>
                <div className="group-count">
                  <b>{g.members}</b>
                  <small>{g.members === 1 ? 'member' : 'members'}</small>
                </div>
              </div>
              <h3>{g.name}</h3>
              <p className="muted">{g.description}</p>
              <p className="group-why">{g.why}</p>
              <div className="group-foot">
                <span className="fine">{g.reachable} can receive offers</span>
                <div className="actions">
                  <Link className="btn small" to={`/admin/members?group=${g.id}`}>View</Link>
                  {me.role === 'owner' && (
                    <a className="btn small" href={`/api/admin/customers.csv?group=${g.id}`} title="Download as a spreadsheet" aria-label={`Download ${g.name}`}>
                      <Icon name="download" size={16} />
                    </a>
                  )}
                  {me.role === 'owner' && (
                    <Link className="btn small primary" to={`/admin/campaigns?group=${g.id}`}>Message</Link>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="fine">
        Messages only go to members who agreed to receive offers. Why these groups? See the retention research: a head start, nudges when people are close to a reward,
        and attention for new, light and drifting customers do the most to bring people back.
      </p>
    </div>
  );
}
