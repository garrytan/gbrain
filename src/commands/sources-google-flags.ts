/**
 * The Google-kind tuning flags of the legacy `gbrain sources add` parser
 * (`--history-days`, `--future-days`, `--loops-exclude-labels`,
 * `--calendar-id`): one value each, validated the moment they are read.
 * The connected-source parser (sources-lifecycle-args.ts) validates the same
 * flags through the operation contract; this module keeps the legacy path's
 * exit-2 behaviour without growing runAdd.
 */
import { CALENDAR_FUTURE_DAYS_MAX } from '../core/google/calendar-window.ts';
import { parseExcludeLabelTokens } from '../core/google/loops-exclusion.ts';
import { DEFAULT_CALENDAR_ID } from '../core/google/types.ts';

export interface GoogleAddTuning {
  historyDays: number;
  calendarId: string;
  futureDays?: number;
  loopsExcludeLabels?: string[];
}

export const defaultGoogleAddTuning = (): GoogleAddTuning => ({ historyDays: 90, calendarId: DEFAULT_CALENDAR_ID });

const refuse = (message: string): never => {
  console.error(message);
  process.exit(2);
};

/** Consumes `flag` with its `value` into `tuning`; false when the flag is not a Google tuning flag. */
export function parseGoogleAddFlag(flag: string, value: string | undefined, tuning: GoogleAddTuning): boolean {
  switch (flag) {
    case '--history-days': {
      const v = Number(value);
      if (!Number.isInteger(v) || v <= 0) refuse('--history-days must be a positive integer.');
      tuning.historyDays = v;
      return true;
    }
    case '--future-days': {
      const v = Number(value);
      if (!Number.isInteger(v) || v <= 0 || v > CALENDAR_FUTURE_DAYS_MAX) refuse(`--future-days must be a whole number between 1 and ${CALENDAR_FUTURE_DAYS_MAX}.`);
      tuning.futureDays = v;
      return true;
    }
    case '--loops-exclude-labels': {
      const labels = parseExcludeLabelTokens(value);
      if (labels.length === 0) refuse('--loops-exclude-labels needs a comma-separated list of Gmail label names or ids.');
      tuning.loopsExcludeLabels = labels;
      return true;
    }
    case '--calendar-id': {
      const v = (value ?? '').trim();
      if (!v) refuse('--calendar-id needs a value (see: gbrain google calendars).');
      tuning.calendarId = v;
      return true;
    }
    default:
      return false;
  }
}
