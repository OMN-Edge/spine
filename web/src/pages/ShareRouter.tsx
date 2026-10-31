import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import PublicShareView from './PublicShareView';
import CardView from './CardView';

/**
 * `/share/:id` is the address of both a share and an emergency card, so no part of the front (the proxy's rules for shared addresses, the
 * content security policy, the shell route) had to learn a new path. The server says which it is, before anything is opened.
 */
export default function ShareRouter() {
  const { id } = useParams();
  const [kind, setKind] = useState<'share' | 'card' | null>(null);
  useEffect(() => {
    if (!id) return;
    fetch(`/api/shared/${encodeURIComponent(id)}/meta`).then(r => r.ok ? r.json() : null).then(m => setKind(m?.kind === 'card' ? 'card' : 'share')).catch(() => setKind('share'));
  }, [id]);
  if (!id || kind === null) return <div className="min-h-screen" />;
  return kind === 'card' ? <CardView id={id} /> : <PublicShareView />;
}
