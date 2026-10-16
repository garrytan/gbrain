export function nearLatest(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function followLatestOnUpdate(input: { opened: boolean; generationStarted: boolean; following: boolean }): boolean {
  return input.opened || input.generationStarted || input.following;
}
