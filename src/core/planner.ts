import { addDays, formatIso, type IctDate, ictToday, weekdayOf } from './ict.js';
import { type Config, type Credentials, expandSlotHours, resolveCourtPriority } from './types.js';

function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffledAccounts(credentials: readonly Credentials[], targetDate: IctDate): Credentials[] {
  const result = [...credentials];
  const rng = mulberry32(hashSeed(formatIso(targetDate)));
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j] as Credentials, result[i] as Credentials];
  }
  return result;
}

export interface BookingTask {
  readonly credentials: Credentials;
  readonly hour: number;
  readonly courtPriority: readonly number[];
}

export interface Plan {
  readonly targetDate: IctDate;
  readonly tasks: readonly BookingTask[];
}

export function buildPlan(
  config: Config,
  credentials: readonly Credentials[],
  today: IctDate = ictToday(),
  advanceDays = 6,
): Plan | null {
  const targetDate = addDays(today, advanceDays);
  const weekday = weekdayOf(targetDate);
  const entry = config.schedule.find((s) => s.days.includes(weekday));
  if (!entry) return null;

  const assignments: BookingTask[] = [];
  const eligible = config.randomizeAccounts ? shuffledAccounts(credentials, targetDate) : credentials;
  let accountIndex = 0;
  for (const slot of entry.slots) {
    const courtPriority = resolveCourtPriority(slot.courts);
    for (const hour of expandSlotHours(slot)) {
      const creds = eligible[accountIndex];
      if (!creds) {
        throw new Error(
          `plan for ${formatIso(targetDate)} needs ${accountIndex + 1} bookings but only ${credentials.length} accounts configured (1 booking per user per day)`,
        );
      }
      assignments.push({ credentials: creds, hour, courtPriority });
      accountIndex += 1;
    }
  }
  return { targetDate, tasks: assignments };
}
