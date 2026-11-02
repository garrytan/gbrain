export function relaxed(): boolean {
  return process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1';
}
