import { log } from '../adapters/logger.js';
import { AbpError } from '../core/errors.js';
import { formatIso, type IctDate } from '../core/ict.js';
import type { BookingTask } from '../core/planner.js';
import type { BookingGateway } from '../core/ports.js';
import { courtNumberOf } from '../core/types.js';

export interface TaskResult {
  readonly account: string;
  readonly hour: number;
  readonly ok: boolean;
  readonly courtNumber?: number;
  readonly bookingCode?: string;
  readonly reason?: string;
}

export interface RaceTiming {
  /** Random delay between consecutive booking attempts (human-like pacing). */
  readonly attemptMinDelayMs: number;
  readonly attemptMaxDelayMs: number;
  /** Random start offset per account so accounts don't fire in lockstep. */
  readonly accountStaggerMaxMs: number;
}

const NO_TIMING: RaceTiming = { attemptMinDelayMs: 0, attemptMaxDelayMs: 0, accountStaggerMaxMs: 0 };

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

class SameCourtCoordinator {
  private wonCourtId: number | null = null;

  reportWin(courtId: number): void {
    this.wonCourtId ??= courtId;
  }

  reorder(priority: readonly number[]): number[] {
    if (this.wonCourtId === null || !priority.includes(this.wonCourtId)) return [...priority];
    return [this.wonCourtId, ...priority.filter((id) => id !== this.wonCourtId)];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runTask(
  client: BookingGateway,
  task: BookingTask,
  targetDate: IctDate,
  todayDate: IctDate,
  deadline: Date,
  retryDelayMs: number,
  coordinator: SameCourtCoordinator,
  wonAccounts: Set<string>,
  timing: RaceTiming,
): Promise<TaskResult> {
  const label = `${task.credentials.name}@${task.hour}:00`;
  let lastError = 'no attempt made';
  let firstAttempt = true;

  while (Date.now() < deadline.getTime()) {
    if (wonAccounts.has(task.credentials.name)) {
      const result: TaskResult = {
        account: task.credentials.name,
        hour: task.hour,
        ok: false,
        reason: 'account already won earlier',
      };
      log.info(`${label} skipped — account ${task.credentials.name} already booked`);
      return result;
    }
    for (const courtId of coordinator.reorder(task.courtPriority)) {
      if (Date.now() >= deadline.getTime()) break;
      // Pace attempts like a human: the very first shot fires immediately at
      // fireAt, every later attempt waits a random jitter so the burst doesn't
      // trip the server's "booking too frequently" rate limit.
      if (!firstAttempt) {
        await sleep(randomBetween(timing.attemptMinDelayMs, timing.attemptMaxDelayMs));
        if (Date.now() >= deadline.getTime()) break;
      }
      firstAttempt = false;
      let bookingId: number;
      try {
        bookingId = await client.createBooking(targetDate, todayDate, task.hour, courtId);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof AbpError && error.unAuthorizedRequest) {
          log.warn(`${label} token rejected, re-authenticating`);
          await client.authenticate(task.credentials.username, task.credentials.password);
        } else {
          log.warn(`${label} court ${courtNumberOf(courtId)} failed: ${lastError}`);
        }
        continue;
      }

      // Booking succeeded — the slot is ours. Everything below is best-effort.
      coordinator.reportWin(courtId);

      let bookingCode: string | undefined;
      try {
        const view = await client.getBooking(bookingId);
        bookingCode = view.booking.bookingCode;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.warn(`${label} getBooking failed (booking id ${bookingId}): ${msg}`);
      }

      wonAccounts.add(task.credentials.name);
      const result: TaskResult = {
        account: task.credentials.name,
        hour: task.hour,
        ok: true,
        courtNumber: courtNumberOf(courtId),
        ...(bookingCode !== undefined ? { bookingCode } : {}),
      };
      log.info(`${label} BOOKED`, result);
      return result;
    }
    await sleep(retryDelayMs);
  }

  const result: TaskResult = {
    account: task.credentials.name,
    hour: task.hour,
    ok: false,
    reason: lastError,
  };
  log.error(`${label} FAILED after deadline`, result);
  return result;
}

export async function executePlan(
  clients: ReadonlyMap<string, BookingGateway>,
  tasks: readonly BookingTask[],
  targetDate: IctDate,
  todayDate: IctDate,
  deadline: Date,
  retryDelayMs: number,
  timing: RaceTiming = NO_TIMING,
): Promise<TaskResult[]> {
  const coordinator = new SameCourtCoordinator();
  const wonAccounts = new Set<string>();
  log.info(`executing ${tasks.length} booking tasks for ${formatIso(targetDate)}`);
  return Promise.all(
    tasks.map((task, index) => {
      const client = clients.get(task.credentials.name);
      if (!client) throw new Error(`no client for account "${task.credentials.name}"`);
      // Stagger account starts: the first task fires immediately at fireAt, the
      // others get a random offset so two accounts never hit the API in lockstep.
      const stagger = index === 0 ? 0 : randomBetween(0, timing.accountStaggerMaxMs);
      return sleep(stagger).then(() =>
        runTask(client, task, targetDate, todayDate, deadline, retryDelayMs, coordinator, wonAccounts, timing),
      );
    }),
  );
}
