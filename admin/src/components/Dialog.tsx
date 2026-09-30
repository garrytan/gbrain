import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Modal keyboard behavior shared by registration, delivery, and client details. */
export function Dialog({ title, titleId, children, onClose, busy = false, drawer = false }: {
  title: string; titleId: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const blocked = useRef(busy);
  blocked.current = busy;
  const [previousFocus] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!blocked.current) close.current();
      }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')]
        .filter(control => control.getClientRects().length > 0 && !control.closest('fieldset:disabled'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
    };
    element.addEventListener('keydown', keydown);
    return () => { element.removeEventListener('keydown', keydown); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [previousFocus]);
  return <div className={drawer ? 'drawer-overlay' : 'modal-overlay'} onClick={() => { if (!busy) onClose(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1}
      className={drawer ? 'drawer' : 'modal'} onClick={event => event.stopPropagation()}
      style={drawer ? { width: 'min(640px, 95vw)' } : { maxWidth: 760, width: '92vw', minWidth: 0, maxHeight: '90vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start', marginBottom: 20 }}>
        <h2 id={titleId} className="modal-title" style={{ margin: 0 }}>{title}</h2>
        <button type="button" className="btn btn-secondary" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}>Close</button>
      </div>
      {children}
    </div>
  </div>;
}
