import { useEffect, useState } from 'react';
import { api } from '../api';

export interface Grant {
  clientId: string; clientName: string; profile: string | null; revision: number;
  scopes: string[]; sourceId: string; federatedRead: string[];
  boundSlugPrefixes: string[] | null; allowedOperations: string[] | null;
  boundTools: string[] | null; boundSourceId: string | null; boundBrainId: string | null;
  delegatedSlugPrefixes: string[] | null; delegatedNamespace: 'job' | 'prefixes';
  boundMaxConcurrent: number; budgetUsdPerDay: string | null; tokenTtlSeconds: number | null;
  surface: string | null; repairReasons: string[];
}
export interface GrantSource { id: string; name: string; federated: boolean }
export interface GrantCatalog { profiles: string[]; delegatedTools: string[]; operations: string[]; harnesses: { id: string; label: string; documentation: string }[] }
export interface GrantPreviewResult { before: Grant | null; after: Grant; revision: number; dryRun: boolean; tokenImplications: string }
export interface GrantDraft {
  profile: string; applyProfile: boolean; source: string; reads: string[]; scopes: string;
  directPrefixes: string; tools: string[]; namespace: 'job' | 'prefixes'; delegatedPrefixes: string;
  concurrency: string; budget: string; ttl: string; surface: string;
  operationSnapshot: string; editOperations: boolean;
}
const split = (text: string) => text.split(/[\s,]+/).filter(Boolean);
export function grantDraft(grant?: Grant): GrantDraft {
  return {
    profile: grant?.profile ?? 'memory-writer', applyProfile: !grant, source: grant?.sourceId ?? 'default', reads: grant?.federatedRead ?? ['default'],
    scopes: grant?.scopes.join(' ') ?? '', directPrefixes: grant?.boundSlugPrefixes?.join('\n') ?? '',
    tools: grant?.boundTools ?? [], namespace: grant?.delegatedNamespace ?? 'job', delegatedPrefixes: grant?.delegatedSlugPrefixes?.join('\n') ?? '',
    concurrency: String(grant?.boundMaxConcurrent ?? 1), budget: grant?.budgetUsdPerDay ?? 'unlimited',
    ttl: grant ? String(grant.tokenTtlSeconds ?? 0) : '3600', surface: grant?.surface ?? 'starter',
    operationSnapshot: grant?.allowedOperations?.join('\n') ?? '', editOperations: false,
  };
}
export function grantRequest(draft: GrantDraft): Record<string, unknown> {
  const delegates = draft.scopes ? split(draft.scopes).includes('agent') : ['full', 'delegating-agent'].includes(draft.profile);
  return {
    ...(draft.applyProfile ? { profile: draft.profile } : {}),
    sourceId: draft.source, federatedRead: draft.reads, boundSlugPrefixes: draft.directPrefixes.trim() ? split(draft.directPrefixes) : null,
    ...(draft.scopes.trim() ? { scopes: split(draft.scopes) } : {}),
    ...(draft.editOperations ? { allowedOperations: split(draft.operationSnapshot) } : {}),
    ...(delegates ? { boundTools: draft.tools, boundSourceId: draft.source, delegatedNamespace: draft.namespace,
      delegatedSlugPrefixes: draft.namespace === 'job' ? null : split(draft.delegatedPrefixes) } : {}),
    boundMaxConcurrent: Number(draft.concurrency), budgetUsdPerDay: draft.budget === 'unlimited' ? null : draft.budget,
    tokenTtl: draft.ttl === '0' ? null : Number(draft.ttl), surface: draft.surface === 'default' ? null : draft.surface,
  };
}
/** Commit the reviewed snapshot itself, so a server upgrade between preview
 * and apply cannot silently add newly registered operations to a profile. */
export function reviewedGrantRequest(grant: Grant): Record<string, unknown> {
  return {
    ...(grant.profile ? { profile: grant.profile } : {}), scopes: grant.scopes, sourceId: grant.sourceId, federatedRead: grant.federatedRead,
    boundSlugPrefixes: grant.boundSlugPrefixes, allowedOperations: grant.allowedOperations, boundTools: grant.boundTools,
    boundSourceId: grant.boundSourceId, boundBrainId: grant.boundBrainId, delegatedNamespace: grant.delegatedNamespace,
    delegatedSlugPrefixes: grant.delegatedSlugPrefixes, boundMaxConcurrent: grant.boundMaxConcurrent,
    budgetUsdPerDay: grant.budgetUsdPerDay, tokenTtlSeconds: grant.tokenTtlSeconds, surface: grant.surface,
  };
}

export function GrantFields({ draft, setDraft, sources, catalog, existing = false }: {
  draft: GrantDraft; setDraft: (draft: GrantDraft) => void; sources: GrantSource[]; catalog: GrantCatalog; existing?: boolean;
}) {
  const change = <K extends keyof GrantDraft>(key: K, value: GrantDraft[K]) => setDraft({ ...draft, [key]: value });
  const available = new Set(sources.map(s => s.id));
  const delegates = draft.scopes ? split(draft.scopes).includes('agent') : ['full', 'delegating-agent'].includes(draft.profile);
  const field = { marginBottom: 14 };
  return <>
    <div style={field}><label htmlFor="grant-profile">Permission profile</label>
      <select id="grant-profile" value={draft.profile} onChange={e => setDraft({ ...draft, profile: e.target.value, applyProfile: true, scopes: '', editOperations: false, surface: ['operator', 'full'].includes(e.target.value) ? 'full' : 'starter' })}>
        {catalog.profiles.map(profile => <option key={profile}>{profile}</option>)}
      </select>
      <p className="grant-help">Memory writer lets this agent recall, save, correct, and withdraw memory. Delegating profiles also allow selected server tools to run jobs.</p>
      {existing && <label className="checkbox-label"><input type="checkbox" checked={draft.applyProfile} onChange={e => change('applyProfile', e.target.checked)} />Apply this profile's current operation snapshot</label>}
    </div>
    <div style={field}><label htmlFor="grant-source">Primary / write source</label><select id="grant-source" value={draft.source} onChange={e => change('source', e.target.value)}>
      {!available.has(draft.source) && <option value={draft.source}>{draft.source} · unavailable</option>}
      {sources.map(source => <option key={source.id} value={source.id}>{source.name} ({source.id})</option>)}
    </select></div>
    <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}><legend>Readable sources</legend>
      {[...sources, ...draft.reads.filter(id => !available.has(id)).map(id => ({ id, name: `${id} · unavailable` }))].map(source => <label className="checkbox-label" key={source.id}>
        <input type="checkbox" checked={draft.reads.includes(source.id)} onChange={e => change('reads', e.target.checked ? [...draft.reads, source.id] : draft.reads.filter(id => id !== source.id))} />{source.name}
      </label>)}
    </fieldset>
    <div style={field}><label htmlFor="grant-direct-prefixes">Direct write prefixes (one per line)</label><textarea id="grant-direct-prefixes" rows={2} value={draft.directPrefixes} onChange={e => change('directPrefixes', e.target.value)} placeholder="work-example/" />
      <p className="grant-help">Blank grants the whole primary source. Coding agent requires an explicit prefix.</p></div>
    {delegates && <fieldset style={{ border: '1px solid var(--border)', padding: 12, marginBottom: 14 }}><legend>Delegated jobs</legend>
      <p className="grant-help">Choose every tool explicitly. Jobs stay in the primary source; existing jobs retain their original limits.</p>
      <div className="checkbox-group" style={{ maxHeight: 180, overflowY: 'auto' }}>{[...new Set([...catalog.delegatedTools, ...draft.tools])].map(tool => <label className="checkbox-label" key={tool}>
        <input type="checkbox" checked={draft.tools.includes(tool)} onChange={e => change('tools', e.target.checked ? [...draft.tools, tool] : draft.tools.filter(name => name !== tool))} />{tool}{!catalog.delegatedTools.includes(tool) ? ' · unavailable' : ''}
      </label>)}</div>
      <label htmlFor="grant-namespace">Delegated write namespace</label><select id="grant-namespace" value={draft.namespace} onChange={e => change('namespace', e.target.value as 'job' | 'prefixes')}>
        <option value="job">Each job's own wiki/agents/ directory</option><option value="prefixes">Explicit prefixes</option>
      </select>
      {draft.namespace === 'prefixes' && <textarea aria-label="Delegated prefixes" rows={2} value={draft.delegatedPrefixes} onChange={e => change('delegatedPrefixes', e.target.value)} placeholder="work-example/" />}
    </fieldset>}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, ...field }}>
      <div><label htmlFor="grant-concurrency">Concurrent jobs</label><input id="grant-concurrency" type="number" min={1} step={1} value={draft.concurrency} onChange={e => change('concurrency', e.target.value)} /></div>
      <div><label htmlFor="grant-budget">Daily delegated spend (USD)</label><input id="grant-budget" value={draft.budget} onChange={e => change('budget', e.target.value)} placeholder="unlimited" />
        <p className="grant-help">Use unlimited for no spending cap, or an amount such as 2.50.</p></div>
    </div>
    <div style={field}><label htmlFor="grant-ttl">Future access token lifetime (seconds)</label><input id="grant-ttl" type="number" min={0} max={7776000} step={1} value={draft.ttl} onChange={e => change('ttl', e.target.value)} />
      <p className="grant-help">Renewable: 3600 (1 hour). Static bearer: 2592000 (30 days). 0 uses the server default. Existing tokens keep their expiry.</p></div>
    <details style={field}><summary>Advanced permissions</summary>
      <label htmlFor="grant-scopes">Scope override</label><input id="grant-scopes" value={draft.scopes} onChange={e => change('scopes', e.target.value)} placeholder="Use profile scopes" />
      <p className="grant-help">read, write, admin, and agent are distinct grants. Admin does not authorize delegation.</p>
      <label htmlFor="grant-surface">Visible tool catalog</label><select id="grant-surface" value={draft.surface} onChange={e => change('surface', e.target.value)}>
        {['verbs', 'starter', 'full', 'default'].map(value => <option key={value}>{value}</option>)}
      </select><p className="grant-help">Full shows all eligible tools; it does not grant additional authority.</p>
      <label className="checkbox-label"><input type="checkbox" checked={draft.editOperations} onChange={e => change('editOperations', e.target.checked)} />Replace operation authority snapshot</label>
      {draft.editOperations && <><textarea aria-label="Allowed operations" rows={5} value={draft.operationSnapshot} onChange={e => change('operationSnapshot', e.target.value)} /><p className="grant-help">One operation name per line. An empty list denies every operation, including delegated tools.</p></>}
    </details>
  </>;
}

const summaries: [string, keyof Grant][] = [['Profile', 'profile'], ['Scopes', 'scopes'], ['Write source', 'sourceId'], ['Readable sources', 'federatedRead'], ['Direct prefixes', 'boundSlugPrefixes'], ['Visible catalog', 'surface'], ['Operation authority', 'allowedOperations'], ['Delegated tools', 'boundTools'], ['Delegated source', 'boundSourceId'], ['Delegated brain', 'boundBrainId'], ['Delegated namespace', 'delegatedNamespace'], ['Delegated prefixes', 'delegatedSlugPrefixes'], ['Concurrent jobs', 'boundMaxConcurrent'], ['Daily USD cap', 'budgetUsdPerDay'], ['Future token TTL', 'tokenTtlSeconds']];
function display(value: unknown, key: keyof Grant): string {
  if (value === null) return key === 'budgetUsdPerDay' ? 'Unlimited' : key === 'allowedOperations' ? 'Legacy scope-based catalog' : 'Unset';
  return Array.isArray(value) ? value.join(', ') || '(none)' : String(value);
}
function PreviewValue({ grant, field }: { grant: Grant; field: keyof Grant }) {
  const value = grant[field];
  if (field === 'allowedOperations' && Array.isArray(value) && value.length > 8) return <details><summary>{value.length} operations · inspect list</summary><div style={{ maxHeight: 160, overflowY: 'auto', marginTop: 8 }}>{value.join(', ')}</div></details>;
  return <>{display(value, field)}</>;
}
export function GrantPreview({ preview }: { preview: GrantPreviewResult }) {
  return <div aria-live="polite" style={{ margin: '16px 0' }}><h3>Review permissions</h3>
    <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Permission</th>{preview.before && <th>Current</th>}<th>Proposed</th></tr></thead><tbody>
      {summaries.filter(([, key]) => !preview.before || JSON.stringify(preview.before[key]) !== JSON.stringify(preview.after[key])).map(([label, key]) => <tr key={key}><th>{label}</th>{preview.before && <td style={{ overflowWrap: 'anywhere', maxWidth: 200 }}><PreviewValue grant={preview.before} field={key} /></td>}<td style={{ overflowWrap: 'anywhere', maxWidth: 280 }}><PreviewValue grant={preview.after} field={key} /></td></tr>)}
    </tbody></table></div><p className="grant-help">{preview.tokenImplications}</p>
  </div>;
}

export function ClientGrantEditor({ clientId, sources, onRescoped }: { clientId: string; sources: GrantSource[]; onRescoped: (grant: { sourceId: string; federatedRead: string[] }) => void }) {
  const [grant, setGrant] = useState<Grant>(); const [draft, setDraft] = useState<GrantDraft>(); const [catalog, setCatalog] = useState<GrantCatalog>();
  const [preview, setPreview] = useState<GrantPreviewResult>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false);
  const reload = async () => {
    const [detail, nextCatalog] = await Promise.all([api.clientGrant(clientId), api.grantCatalog()]);
    setGrant(detail.grant); setDraft(grantDraft(detail.grant)); setCatalog(nextCatalog); setPreview(undefined); setError('');
  };
  useEffect(() => { void reload().catch(e => setError(e.message)); }, [clientId]);
  const submit = async () => {
    if (!draft || !grant) return; setBusy(true); setError(''); setSaved(false);
    try {
      const result = await api.updateClientGrant(clientId, { ...(preview ? reviewedGrantRequest(preview.after) : grantRequest(draft)), expectedRevision: grant.revision, dryRun: !preview }) as GrantPreviewResult;
      if (!preview) setPreview(result);
      else { setGrant(result.after); setDraft(grantDraft(result.after)); setPreview(undefined); setSaved(true); onRescoped(result.after); }
    } catch (e) { setPreview(undefined); setError(e instanceof Error ? e.message : 'Grant update failed'); }
    finally { setBusy(false); }
  };
  return <section><div className="section-title">Permissions</div>
    {grant && <p className="grant-help">Revision {grant.revision}. Review source access, direct tools, and delegated work independently.</p>}
    {grant && <ClientSpend clientId={clientId} revision={grant.revision} />}
    {!!grant?.repairReasons.length && <p role="status" style={{ color: 'var(--warning)' }}>Delegation needs repair: {grant.repairReasons.join(', ')}. Review and explicitly grant the missing bindings below.</p>}
    {draft && catalog && <GrantFields draft={draft} catalog={catalog} sources={sources} existing setDraft={next => { setDraft(next); setPreview(undefined); setSaved(false); }} />}
    {error && <p role="alert" style={{ color: 'var(--error)' }}>{error} <button type="button" className="btn btn-secondary" onClick={() => void reload().catch(e => setError(e.message))}>Reload current grant</button></p>}
    {preview && <GrantPreview preview={preview} />}
    {saved && <p role="status">Permissions saved. Credentials are unchanged.</p>}
    <button type="button" className="btn btn-primary" disabled={busy || !draft || !catalog} onClick={() => void submit()}>{busy ? 'Checking…' : preview ? 'Apply reviewed changes' : 'Preview changes'}</button>
  </section>;
}

function ClientSpend({ clientId, revision }: { clientId: string; revision: number }) {
  const [spend, setSpend] = useState<{ cap_usd_per_day: number | null; spent_cents_today: number; pending_cents: number; unknown_count: number; inflight_count: number }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => void api.agentsSpend().then(rows => {
      if (active) { setSpend(rows.find((row: { client_id: string }) => row.client_id === clientId)); setError(false); }
    }).catch(() => { if (active) setError(true); });
    refresh(); const timer = setInterval(refresh, 20_000);
    return () => { active = false; clearInterval(timer); };
  }, [clientId, revision]);
  if (error) return <p role="status">Delegated spend is unavailable. Reload to check before starting more work.</p>;
  if (!spend) return null;
  return <div style={{ border: '1px solid var(--border)', padding: 12, marginBottom: 14 }}>
    <strong>Delegated work</strong>
    <p>{spend.inflight_count} unfinished jobs · Daily cap: {spend.cap_usd_per_day === null ? 'Unlimited' : `$${spend.cap_usd_per_day.toFixed(2)}`}</p>
    <p className="grant-help">Recorded today: ${(spend.spent_cents_today / 100).toFixed(2)}. Known outstanding reservations: ${(spend.pending_cents / 100).toFixed(2)}, including overdue calls from earlier days.</p>
    {spend.unknown_count > 0 && <p role="status" style={{ color: 'var(--warning)' }}>{spend.unknown_count} unresolved calls have an unknown cost. The known amounts above do not bound total liability; a finite cap refuses further calls until reconciliation.</p>}
  </div>;
}

export function HarnessGuides({ serverUrl, clientId, credentialFile = true }: { serverUrl: string; clientId: string; credentialFile?: boolean }) {
  const [catalog, setCatalog] = useState<GrantCatalog>();
  useEffect(() => { void api.grantCatalog().then(setCatalog).catch(() => {}); }, []);
  return <section><div className="section-title">Connect this agent</div>
    <p>Follow your harness guide for the supported connection and reload steps. Grok Bot and Muse can use GBrain inside their own computer when its prerequisites pass.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{catalog?.harnesses.map(harness => <a key={harness.id} href={harness.documentation} target="_blank" rel="noreferrer">{harness.label}</a>)}</div>
    {credentialFile ? <><p className="grant-help">Use the credential file saved at registration in the target environment. Restrict its file permissions to the owner before connecting.</p>
      <div className="code-block"><pre style={{ whiteSpace: 'pre-wrap' }}>{`gbrain connect ${serverUrl}/mcp --credentials-file /absolute/private/credentials.json --harness YOUR_HARNESS --install`}</pre></div></>
      : <p className="grant-help">Follow your harness guide for this credential type. The thin CLI used by Grok Bot and Muse requires a renewable OAuth client with client_credentials; register one above to use that connection.</p>}
    <p className="grant-help">Client ID: {clientId}. Installing on the server host does not configure a different agent's computer.</p>
  </section>;
}
