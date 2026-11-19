import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import pkg from 'cron-parser';

const { parseExpression } = pkg as { parseExpression: (expr: string, opts?: Record<string, unknown>) => { prev: () => Date; next: () => Date } };

const TICK_MS = 30_000;
const RUN_TIMEOUT_MS = 12_000;

/**
 * Real cron execution for Cloudlane scheduled jobs.
 *
 * Every 30s: find enabled cron services, evaluate their schedule for the
 * current minute (in the job's timezone, via Intl offset), and fire the
 * configured HTTP request once per due minute. Results land in CronRun so the
 * panel shows genuine run history.
 */
@Injectable()
export class CronRunnerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CronRunner');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** serviceId -> last fired epoch-minute (dedupe across ticks) */
  private readonly firedMinutes = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.logger.log('Cron runner started (tick 30s)');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Offset of a named timezone vs UTC at the given instant, in minutes. */
  private tzOffsetMinutes(timezone: string, at: Date): number {
    try {
      const dtf = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const parts = dtf.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
      const asUTC = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
      );
      return Math.round((asUTC - at.getTime()) / 60_000);
    } catch {
      return 0;
    }
  }

  /** Does the cron expression fire at epoch-minute `minuteMs` (in job tz)? */
  private isDue(expr: string, timezone: string, minuteMs: number): boolean {
    const offset = this.tzOffsetMinutes(timezone, new Date(minuteMs));
    const wall = new Date(minuteMs - offset * 60_000);
    const it = parseExpression(expr, { currentDate: wall });
    return it.prev().getTime() === wall.getTime();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const minute = Math.floor(now / 60_000) * 60_000;
      const jobs = await this.prisma.service.findMany({
        where: { kind: 'cron', enabled: true },
        select: { id: true, name: true, schedule: true, timezone: true, method: true, targetUrl: true },
      });
      for (const job of jobs) {
        if ((this.firedMinutes.get(job.id) ?? 0) >= minute) continue;
        let due = false;
        try {
          due = this.isDue(job.schedule, job.timezone || 'UTC', minute);
        } catch {
          due = false; // invalid schedule — skip silently, stays visible in UI
        }
        if (!due) continue;
        this.firedMinutes.set(job.id, minute);
        if (this.firedMinutes.size > 500) {
          for (const [k, v] of this.firedMinutes) if (v < minute - 3_600_000) this.firedMinutes.delete(k);
        }
        await this.execute(job.id, job.name, job.method || 'GET', job.targetUrl);
      }
    } catch (err) {
      this.logger.warn(`tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async execute(
    serviceId: string, name: string, method: string, targetUrl: string,
  ): Promise<void> {
    const started = Date.now();
    let status = 'success';
    let code: string | null = null;
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    try {
      const res = await fetch(targetUrl, { method, signal: controller.signal });
      code = `${res.status} ${res.statusText}`.trim();
      if (!res.ok) status = 'failed';
    } catch (err) {
      status = 'failed';
      code = (err as Error).name === 'AbortError' ? 'timeout' : `network: ${(err as Error).message}`.slice(0, 60);
    } finally {
      clearTimeout(killer);
    }
    await this.prisma.cronRun.create({
      data: {
        serviceId,
        status,
        code,
        durationMs: String(Date.now() - started),
      },
    });
    this.logger.log(`cron ${name}: ${status} ${code ?? ''}`);
  }
}
