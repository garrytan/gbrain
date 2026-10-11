import { finishedMaintenance, type MaintenanceView } from './home-model';

export function MaintenanceDialog({ view, open, onClose, onRecover }: {
  view: MaintenanceView;
  open: boolean;
  onClose: () => void;
  onRecover: () => void;
}) {
  if (!open) return null;
  const shown = view.visible ? view : finishedMaintenance();
  return <div className="maintenance-layer" onClick={onClose}>
    <section className="maintenance-dialog" role="dialog" aria-modal="true" aria-label={shown.title} onClick={event => event.stopPropagation()}>
      <header><h2>{shown.title}</h2><button type="button" aria-label="关闭" onClick={onClose}>关闭</button></header>
      <p>{shown.message}</p>
      <div className="build-steps">{shown.steps.map(step => <div key={step.id} data-state={step.state}><i />{step.label}</div>)}</div>
      <div className="create-actions"><button type="button" className="home-primary" onClick={onRecover}>打开恢复与更新</button></div>
    </section>
  </div>;
}

export function StatusChip({ kind, label, onClick }: { kind: 'ready' | 'busy'; label: string; onClick: () => void }) {
  return <button type="button" className={kind === 'ready' ? 'home-health' : 'home-maintenance'} onClick={event => { event.stopPropagation(); onClick(); }}><i />{label}</button>;
}
