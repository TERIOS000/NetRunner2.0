import { AbpError } from '../core/errors.js';
import {
  bookingCreationTimeBody,
  bookingDateBody,
  bookingDateQuery,
  formatIso,
  type IctDate,
} from '../core/ict.js';
import type { BookingGateway } from '../core/ports.js';
import { type BookingView, type CourtRow, SPORT_STATION_TENNIS, SPORT_TYPE_TENNIS } from '../core/types.js';

const BASE_URL = 'https://bookyourcourtapi.psm.tu.ac.th';
const FRONTEND_ORIGIN = 'https://bookyourcourt.psm.tu.ac.th';

const DEFAULT_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
] as const;

export function pickDefaultUserAgent(): string {
  return DEFAULT_USER_AGENTS[Math.floor(Math.random() * DEFAULT_USER_AGENTS.length)] as string;
}

interface AbpEnvelope<T> {
  result: T;
  success: boolean;
  error: { code?: number; message: string; details?: string | null } | null;
  unAuthorizedRequest: boolean;
}

export class BookYourCourtClient implements BookingGateway {
  private accessToken: string | null = null;
  private readonly browserHeaders: Record<string, string>;

  constructor(
    private readonly accountName: string,
    private readonly requestTimeoutMs = 8000,
    options: { userAgent?: string } = {},
  ) {
    this.browserHeaders = options.userAgent
      ? {
          'User-Agent': options.userAgent,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
          Origin: FRONTEND_ORIGIN,
          Referer: `${FRONTEND_ORIGIN}/`,
        }
      : {};
  }

  get account(): string {
    return this.accountName;
  }

  async authenticate(username: string, password: string): Promise<void> {
    const result = await this.request<{ accessToken: string }>('POST', '/api/TokenAuth/Authenticate', {
      body: {
        userNameOrEmailAddress: username,
        password,
        rememberClient: false,
        singleSignIn: false,
        returnUrl: null,
        captchaResponse: null,
      },
      skipAuth: true,
    });
    if (!result.accessToken) throw new Error(`authenticate(${this.accountName}): no accessToken in response`);
    this.accessToken = result.accessToken;
  }

  async listCourts(date: IctDate, today: 1 | 2): Promise<CourtRow[]> {
    const query = new URLSearchParams({
      sportTypeId: '0',
      sportStationId: String(SPORT_STATION_TENNIS),
      courtId: '0',
      bookingDate: bookingDateQuery(date),
      today: String(today),
    });
    return this.request<CourtRow[]>('GET', `/api/services/app/Bookings/GetListCourtForBooking?${query}`);
  }

  async createBooking(date: IctDate, todayDate: IctDate, hour: number, courtId: number): Promise<number> {
    const isSameDay = formatIso(date) === formatIso(todayDate);
    return this.request<number>('POST', '/api/services/app/Bookings/CreateOrEdit', {
      body: {
        today: isSameDay ? 1 : 2,
        bookingDate: bookingDateBody(date),
        bookingTime: `${String(hour).padStart(2, '0')}:00`,
        bookingCreationTime: bookingCreationTimeBody(todayDate),
        sportTypeId: SPORT_TYPE_TENNIS,
        sportStationId: SPORT_STATION_TENNIS,
        courtId,
      },
    });
  }

  async getBooking(id: number): Promise<BookingView> {
    return this.request<BookingView>('GET', `/api/services/app/Bookings/GetBookingForView?id=${id}`);
  }

  async cancelBooking(bookingCode: string): Promise<boolean> {
    return this.request<boolean>(
      'POST',
      `/api/services/app/Bookings/CancelBooking?bookingCode=${encodeURIComponent(bookingCode)}`,
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; skipAuth?: boolean } = {},
  ): Promise<T> {
    if (!options.skipAuth && !this.accessToken) {
      throw new Error(`${this.accountName}: not authenticated`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...this.browserHeaders,
          ...(options.skipAuth ? {} : { Authorization: `Bearer ${this.accessToken}` }),
        },
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${path}: request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error instanceof Error ? new Error(`${path}: ${error.message}`) : error;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let envelope: AbpEnvelope<T>;
    try {
      envelope = JSON.parse(text) as AbpEnvelope<T>;
    } catch {
      throw new Error(`${path}: HTTP ${response.status}, non-JSON body: ${text.slice(0, 200)}`);
    }
    if (!envelope.success) {
      throw new AbpError(
        path,
        envelope.error?.message ?? `HTTP ${response.status}`,
        envelope.error?.details ?? null,
        envelope.unAuthorizedRequest,
        envelope.error?.code ?? null,
        response.status,
      );
    }
    return envelope.result;
  }
}
