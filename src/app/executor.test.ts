import { describe, expect, test } from 'bun:test';
import { AbpError } from '../core/errors.js';
import type { IctDate } from '../core/ict.js';
import type { BookingTask } from '../core/planner.js';
import type { BookingGateway } from '../core/ports.js';
import { type BookingView, COURT_IDS, type Credentials } from '../core/types.js';
import { executePlan } from './executor.js';

const DATE: IctDate = { year: 2026, month: 7, day: 20 };
const creds = (name: string): Credentials => ({ name, username: `${name}u`, password: `${name}p` });

class FakeGateway implements BookingGateway {
  authCount = 0;
  readonly createCalls: number[] = [];
  private attempt = 0;

  constructor(
    readonly account: string,
    private readonly script: (attempt: number, courtId: number) => number,
  ) {}

  async authenticate(): Promise<void> {
    this.authCount += 1;
  }

  async listCourts(): Promise<never[]> {
    return [];
  }

  async createBooking(_d: IctDate, _t: IctDate, _h: number, courtId: number): Promise<number> {
    this.createCalls.push(courtId);
    this.attempt += 1;
    return this.script(this.attempt, courtId);
  }

  async getBooking(id: number): Promise<BookingView> {
    return {
      booking: {
        bookingCode: `CODE${id}`,
        bookingDate: '2026/07/20',
        bookingTime: '18:00',
        bookingStatus: 'Confirmed',
        courtId: 0,
        id,
      },
      courtCourtName: 'Court 03',
    };
  }

  async cancelBooking(): Promise<boolean> {
    return true;
  }
}

const task = (name: string, hour: number): BookingTask => ({
  credentials: creds(name),
  hour,
  courtPriority: [COURT_IDS[3] as number],
});

const taskCourts = (name: string, hour: number, courtIds: number[]): BookingTask => ({
  credentials: creds(name),
  hour,
  courtPriority: courtIds,
});

const closedError = (): AbpError =>
  new AbpError('/CreateOrEdit', 'ไม่สามารถจองได้!', 'สนาม/คอร์ตปิดทำการในวัน/เวลาที่คุณเลือก กรุณาเลือกวันอื่น', false);

const rateLimitError = (): AbpError =>
  new AbpError('/CreateOrEdit', 'จองถี่เกินไป', 'คุณทำรายการจองถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', false);

describe('executePlan', () => {
  test('books the first available court and returns the booking code', async () => {
    const gw = new FakeGateway('a', () => 1001);
    const results = await executePlan(
      new Map([['a', gw]]),
      [task('a', 18)],
      DATE,
      DATE,
      new Date(Date.now() + 1000),
      10,
    );
    expect(results[0]).toMatchObject({
      account: 'a',
      hour: 18,
      ok: true,
      courtNumber: 3,
      bookingCode: 'CODE1001',
    });
    expect(gw.createCalls).toEqual([COURT_IDS[3] as number]);
  });

  test('re-authenticates on an unauthorized error then succeeds', async () => {
    const gw = new FakeGateway('a', (attempt) => {
      if (attempt === 1) throw new AbpError('/CreateOrEdit', 'token expired', null, true);
      return 2002;
    });
    const results = await executePlan(
      new Map([['a', gw]]),
      [task('a', 18)],
      DATE,
      DATE,
      new Date(Date.now() + 1000),
      1,
    );
    expect(gw.authCount).toBe(1);
    expect(results[0]).toMatchObject({ ok: true, bookingCode: 'CODE2002' });
  });

  test('fails after the deadline when every attempt errors', async () => {
    const gw = new FakeGateway('a', () => {
      throw new Error('court taken');
    });
    const results = await executePlan(
      new Map([['a', gw]]),
      [task('a', 18)],
      DATE,
      DATE,
      new Date(Date.now() + 40),
      5,
    );
    expect(results[0]).toMatchObject({ ok: false, reason: 'court taken' });
  });

  test('throws when a task has no matching client', async () => {
    const gw = new FakeGateway('a', () => 1);
    await expect(
      executePlan(new Map([['a', gw]]), [task('missing', 18)], DATE, DATE, new Date(Date.now() + 100), 5),
    ).rejects.toThrow(/no client for account "missing"/);
  });

  test('paces attempts with jitter and staggers account starts', async () => {
    const gwA = new FakeGateway('a', () => {
      throw new Error('court taken');
    });
    const gwB = new FakeGateway('b', () => {
      throw new Error('court taken');
    });
    const start = Date.now();
    await executePlan(
      new Map([
        ['a', gwA],
        ['b', gwB],
      ]),
      [task('a', 18), task('b', 19)],
      DATE,
      DATE,
      new Date(Date.now() + 500),
      10,
      { attemptMinDelayMs: 30, attemptMaxDelayMs: 30, accountStaggerMaxMs: 30, rateLimitBackoffMs: 0 },
    );
    // Jitter (30ms) between attempts means at least 2 attempts per account
    // can't happen back-to-back in a burst; stagger delays the 2nd account.
    expect(gwA.createCalls.length).toBeGreaterThan(1);
    expect(gwB.createCalls.length).toBeGreaterThan(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  test('aborts without retrying when every court is closed', async () => {
    const gw = new FakeGateway('a', () => {
      throw closedError();
    });
    const results = await executePlan(
      new Map([['a', gw]]),
      [taskCourts('a', 18, [COURT_IDS[1] as number, COURT_IDS[2] as number])],
      DATE,
      DATE,
      new Date(Date.now() + 1000),
      10,
    );
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.reason).toContain('closed');
    // Each court is attempted exactly once; no repeated rounds re-trigger the
    // server's "booking too frequently" rate limit.
    expect(gw.createCalls).toEqual([COURT_IDS[1] as number, COURT_IDS[2] as number]);
  });

  test('skips a closed court and books the next open one', async () => {
    const gw = new FakeGateway('a', (_attempt, courtId) => {
      if (courtId === (COURT_IDS[1] as number)) throw closedError();
      return 3003;
    });
    const results = await executePlan(
      new Map([['a', gw]]),
      [taskCourts('a', 18, [COURT_IDS[1] as number, COURT_IDS[2] as number])],
      DATE,
      DATE,
      new Date(Date.now() + 1000),
      10,
    );
    expect(results[0]).toMatchObject({ ok: true, courtNumber: 2, bookingCode: 'CODE3003' });
    expect(gw.createCalls).toEqual([COURT_IDS[1] as number, COURT_IDS[2] as number]);
  });

  test('backs off when the server reports booking too frequently', async () => {
    const gw = new FakeGateway('a', () => {
      throw rateLimitError();
    });
    const results = await executePlan(
      new Map([['a', gw]]),
      [task('a', 18)],
      DATE,
      DATE,
      new Date(Date.now() + 200),
      5,
      { attemptMinDelayMs: 0, attemptMaxDelayMs: 0, accountStaggerMaxMs: 0, rateLimitBackoffMs: 60 },
    );
    expect(results[0]).toMatchObject({ ok: false });
    // A 60ms backoff leaves room for only a handful of attempts in the 200ms
    // window, whereas the 5ms retry delay alone would allow dozens.
    expect(gw.createCalls.length).toBeGreaterThan(1);
    expect(gw.createCalls.length).toBeLessThan(6);
  });
});
