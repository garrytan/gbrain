import React, { useState } from 'react';

export async function copyText(value: string): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (copied) return;

  // Keep the legacy copy attempt inside the original click gesture. Some
  // embedded browsers reject the async Clipboard API and end user activation
  // before an awaited fallback can run.
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  throw new Error('copy_failed');
}

export function CopyButton({ value, className = 'copy-btn' }: { value: string; className?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    try {
      await copyText(value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
    window.setTimeout(() => setStatus('idle'), 1800);
  };

  return (
    <button type="button" className={className} onClick={() => void handleCopy()} aria-live="polite">
      {status === 'copied' ? '已复制' : status === 'failed' ? '复制失败' : '复制'}
    </button>
  );
}
