import { describe, expect, test } from 'bun:test';
import { AbpError } from '../core/errors.js';
import type { IctDate } from '../core/ict.js';
import type { BookingTask } from '../core/planner.js';
import type { BookingGateway } from '../core/ports.js';
import { type BookingView, COURT_IDS, type CourtRow, type Credentials } from '../core/types.js';
import { type DatePlan, executeRace, type RaceOptions } from './executor.js';

const DATE: IctDate = { year: 2026, month: 7, day: 20 };
const creds = (name: string): Credentials => ({ name, username: `${name}u`, password: `${name}p` });

const courtRow = (courtId: number): CourtRow => ({
  courtId,
  courtName: `Tennis Court 0${courtId}`,
  bookingDate: '2026/07/20',
});

class FakeGateway implements BookingGateway {
  authCount = 0;
  listCourtsCalls = 0;
  readonly createCalls: number[] = [];
  windowOpenAfterPolls = 0;
  private attempt = 0;

  constructor(
    readonly account: string,
    private readonly script: (attempt: number, courtId: number) => number,
  ) {}

  async authenticate(): Promise<void> {
    this.authCount += 1;
  }

  async listCourts(): Promise<CourtRow[]> {
    this.listCourtsCalls += 1;
    if (this.listCourtsCalls <= this.windowOpenAfterPolls) return [];
    return [courtRow(1)];
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

const task = (name: string, hour: number, courts: number[] = [COURT_IDS[3] as number]): BookingTask => ({
  credentials: creds(name),
  hour,
  courtPriority: courts,
});

const plan = (tasks: BookingTask[]): DatePlan => ({ targetDate: DATE, tasks });

const options = (deadlineMs: number, overrides: Partial<RaceOptions> = {}): RaceOptions => ({
  deadline: new Date(Date.now() + deadlineMs),
  accountIntervalMs: 50,
  ipIntervalMs: 50,
  rateLimitBackoffMs: 50,
  gatePollIntervalMs: 5,
  ...overrides,
});

describe('executeRace', () => {
  test('books the first available court and returns the booking code', async () => {
    const gw = new FakeGateway('a', () => 1001);
    const results = await executeRace(new Map([['a', gw]]), [plan([task('a', 18)])], DATE, options(1000));
    expect(results[0]).toMatchObject({
      account: 'a',
      hour: 18,
      ok: true,
      courtNumber: 3,
      bookingCode: 'CODE1001',
    });
    expect(gw.createCalls).toEqual([COURT_IDS[3] as number]);
  });

  test('waits for the window gate before firing createBooking', async () => {
    const gw = new FakeGateway('a', () => 1001);
    gw.windowOpenAfterPolls = 3;
    const results = await executeRace(new Map([['a', gw]]), [plan([task('a', 18)])], DATE, options(1000));
    expect(results[0]).toMatchObject({ ok: true });
    expect(gw.listCourtsCalls).toBeGreaterThanOrEqual(4);
  });

  test('fails without any createBooking call when the window never opens', async () => {
    const gw = new FakeGateway('a', () => 1001);
    gw.windowOpenAfterPolls = Number.MAX_SAFE_INTEGER;
    const results = await executeRace(new Map([['a', gw]]), [plan([task('a', 18)])], DATE, options(100));
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.reason).toMatch(/never opened/);
    expect(gw.createCalls).toEqual([]);
  });

  test('re-authenticates on an unauthorized error then succeeds', async () => {
    const gw = new FakeGateway('a', (attempt) => {
      if (attempt === 1) throw new AbpError('/CreateOrEdit', 'token expired', null, true);
      return 2002;
    });
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18)])],
      DATE,
      options(1000, { accountIntervalMs: 1, ipIntervalMs: 1 }),
    );
    expect(gw.authCount).toBe(1);
    expect(results[0]).toMatchObject({ ok: true, bookingCode: 'CODE2002' });
  });

  test('backs off after a rate-limit error then retries', async () => {
    const gw = new FakeGateway('a', (attempt) => {
      if (attempt === 1) throw new AbpError('/CreateOrEdit', 'จองถี่เกินไป', 'คุณทำรายการจองถี่เกินไป', false);
      return 3003;
    });
    const start = Date.now();
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18)])],
      DATE,
      options(1000, { accountIntervalMs: 1, ipIntervalMs: 1, rateLimitBackoffMs: 80 }),
    );
    expect(results[0]).toMatchObject({ ok: true, bookingCode: 'CODE3003' });
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
  });

  test('drops a closed court from rotation and books the next one', async () => {
    const closedCourt = COURT_IDS[3] as number;
    const openCourt = COURT_IDS[4] as number;
    const gw = new FakeGateway('a', (_attempt, courtId) => {
      if (courtId === closedCourt) {
        throw new AbpError('/CreateOrEdit', 'ไม่สามารถจองได้!', 'สนาม/คอร์ตปิดทำการในวัน/เวลาที่คุณเลือก', false);
      }
      return 4004;
    });
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18, [closedCourt, openCourt])])],
      DATE,
      options(1000, { accountIntervalMs: 1, ipIntervalMs: 1 }),
    );
    expect(results[0]).toMatchObject({ ok: true, courtNumber: 4 });
    expect(gw.createCalls.filter((id) => id === closedCourt)).toHaveLength(1);
  });

  test('fails fast when every court is closed', async () => {
    const gw = new FakeGateway('a', () => {
      throw new AbpError('/CreateOrEdit', 'ไม่สามารถจองได้!', 'สนาม/คอร์ตปิดทำการในวัน/เวลาที่คุณเลือก', false);
    });
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18)])],
      DATE,
      options(1000, { accountIntervalMs: 1, ipIntervalMs: 1 }),
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.reason).toMatch(/all courts closed/);
    expect(gw.createCalls).toHaveLength(1);
  });

  test('fails after the deadline when every attempt errors', async () => {
    const gw = new FakeGateway('a', () => {
      throw new Error('court taken');
    });
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18)])],
      DATE,
      options(100, { accountIntervalMs: 5, ipIntervalMs: 5, gatePollIntervalMs: 1 }),
    );
    expect(results[0]).toMatchObject({ ok: false, reason: 'court taken' });
  });

  test('runs tasks across two dates and tags results with their target date', async () => {
    const gw = new FakeGateway('a', () => 5005);
    const otherDate: IctDate = { year: 2026, month: 7, day: 21 };
    const results = await executeRace(
      new Map([['a', gw]]),
      [plan([task('a', 18)]), { targetDate: otherDate, tasks: [task('a', 19)] }],
      DATE,
      options(1000, { accountIntervalMs: 1, ipIntervalMs: 1 }),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[0]?.targetDate).toEqual(DATE);
    expect(results[1]?.targetDate).toEqual(otherDate);
  });

  test('throws when a task has no matching client', async () => {
    const gw = new FakeGateway('a', () => 1);
    await expect(
      executeRace(new Map([['a', gw]]), [plan([task('missing', 18)])], DATE, options(100)),
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
