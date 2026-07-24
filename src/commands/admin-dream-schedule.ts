export interface AdminDreamScheduleSettings {
  enabled: boolean;
  time: string;
  lastStartedDate: string | null;
}

export const DEFAULT_ADMIN_DREAM_SCHEDULE_TIME = '02:00';

export function isValidAdminDreamScheduleTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function adminDreamScheduleDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isAdminDreamScheduleDue(
  settings: AdminDreamScheduleSettings,
  now: Date,
): boolean {
  if (!settings.enabled || !isValidAdminDreamScheduleTime(settings.time)) return false;
  const [hour, minute] = settings.time.split(':').map(Number);
  const scheduledMinutes = hour * 60 + minute;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  return currentMinutes >= scheduledMinutes
    && settings.lastStartedDate !== adminDreamScheduleDateKey(now);
}
