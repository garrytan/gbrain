// src/commands/ingest.ts
//
// Operational subcommands for office ingest (docs/proposals/office-ingest.md §12).
// None of these need a connected brain — they manage the Docling sidecar only.

export async function runIngest(args: string[]): Promise<void> {
  const sub = args[1]; // args[0] === 'ingest'

  if (sub === 'setup-docling') {
    const { setupDocling, sidecarDir } = await import('../core/office/sidecar-manage.ts');
    console.log(`Setting up the Docling sidecar at ${sidecarDir()}`);
    console.log('(creates a .venv + installs Docling; the first run downloads ML deps — several GB)');
    const res = await setupDocling((l) => console.error(l));
    console.log(res.ok ? `\n✓ ${res.message}` : `\n✗ ${res.message}`);
    if (res.ok) {
      console.log('\nNext:');
      console.log('  gbrain config set ingest.docling.enabled true');
      console.log('  gbrain import <dir>     # PDF/DOCX/PPTX/XLSX auto-start the sidecar + ingest');
    } else {
      process.exit(1);
    }
    return;
  }

  if (sub === 'start') {
    const { ensureSidecarUp } = await import('../core/office/sidecar-manage.ts');
    // Explicit user retry: bypass the failed-start cooldown.
    const ok = await ensureSidecarUp({ url: 'http://127.0.0.1:8765', startCooldownMs: 0 }, (l) => console.error(l));
    console.log(ok ? '✓ Docling sidecar healthy on :8765.' : '✗ could not start the sidecar — run `gbrain ingest setup-docling` first.');
    if (!ok) process.exit(1);
    return;
  }

  console.log('Usage:');
  console.log('  gbrain ingest setup-docling   create venv + install Docling (one-time)');
  console.log('  gbrain ingest start           start the Docling sidecar (also auto-started on import)');
}
