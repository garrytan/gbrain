import { useState } from 'react';
import { api, mutationOutcomeUnknown } from '../api';
import type { Grant } from './ClientGrant';

type Action = 'invalidate-tokens' | 'revoke' | 'delete';
interface Preview { action: Action; dry_run: boolean; before: Grant; consequences: string | string[] }
const labels: Record<Action, string> = { 'invalidate-tokens': 'Invalidate tokens', revoke: 'Revoke client', delete: 'Delete client' };

export function ClientLifecycle({ clientId, name, revoked, onChanged, onBusyChange }: { clientId: string; name: string; revoked: boolean; onChanged: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const review = async (action: Action) => {
    setBusy(true); setError(''); setPreview(undefined);
    try { setPreview(await api.clientLifecycle(clientId, { action, dryRun: true })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not preview this action. Retry after checking the client.'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      await api.clientLifecycle(clientId, { action: preview.action, dryRun: false, yes: true, expectedRevision: preview.before.revision });
      onChanged();
    } catch (cause) {
      const unknown = mutationOutcomeUnknown(cause);
      setError(`${cause instanceof Error ? cause.message : 'Request failed.'} ${unknown ? 'The action may have completed. Reload the client and inspect its current state before requesting another action.' : 'The request was refused. Review a fresh preview before applying an action.'}`);
      setOutcomeUnknown(unknown); setPreview(undefined);
    } finally { setBusy(false); onBusyChange?.(false); }
  };
  return <section aria-labelledby="client-lifecycle-title" style={{ marginTop: 28 }}>
    <h3 id="client-lifecycle-title" className="section-title">Client access</h3>
    <p className="grant-help">Invalidating tokens keeps the client and its secret. Revoking ends access and keeps a visible registration. Deleting removes the registration. Memory and audit history remain.</p>
    {!preview && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {(['invalidate-tokens', 'revoke', 'delete'] as Action[]).filter(action => !revoked || action === 'delete').map(action => <button key={action} type="button" className="btn btn-secondary" disabled={busy || outcomeUnknown} onClick={() => void review(action)}>{labels[action]}</button>)}
    </div>}
    {preview && <div aria-live="polite" style={{ border: '1px solid var(--border)', padding: 16 }}>
      <h4 style={{ margin: '0 0 12px' }}>{labels[preview.action]}: {name}</h4>
      <p><code>{clientId}</code> · Revision {preview.before.revision}</p>
      <ul>{(Array.isArray(preview.consequences) ? preview.consequences : [preview.consequences]).map((consequence, index) => <li key={index}>{consequence}</li>)}</ul>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void apply()}>{busy ? 'Applying…' : `Confirm ${labels[preview.action].toLowerCase()}`}</button>
      </div>
    </div>}
    {error && <p role="alert" style={{ color: 'var(--error)' }}>{error} {outcomeUnknown && <button type="button" className="btn btn-secondary" onClick={onChanged}>Reload client list</button>}</p>}
  </section>;
}
