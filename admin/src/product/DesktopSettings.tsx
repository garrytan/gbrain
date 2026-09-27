import React, { useEffect, useRef, useState } from 'react';
import template from '../../../desktop/src/renderer/settings-content.html?raw';
import { desktopApi } from '../lib/product-fetch';

let controller: Promise<typeof import('../../../desktop/src/renderer/src')> | undefined;

export function DesktopSettings({ panel, visible, theme }: { panel: string; visible: boolean; theme: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!desktopApi() || !host.current) return;
    if (!host.current.childElementCount) host.current.innerHTML = template;
    controller ??= import('../../../desktop/src/renderer/src');
    controller.then(() => setInitialized(true)).catch(reason => setError(String(reason)));
  }, []);
  useEffect(() => {
    if (!visible || !controller) return;
    let active = true;
    controller.then(module => {
      if (active) module.activateSettingsPanel(panel as Parameters<typeof module.activateSettingsPanel>[0]);
    }).catch(reason => setError(String(reason)));
    return () => { active = false; };
  }, [panel, visible]);
  return <div className="desktop-settings-container" hidden={!visible}>
    {error && <p role="alert">{error}</p>}
    <div className="desktop-settings" hidden={!initialized} data-theme={theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme} ref={host} />
  </div>;
}
