import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/index.js';
import type { Job } from '@organizer/shared';

export type JobHandler = (job: Job) => Promise<void> | void;

export class Scheduler {
  private db: Database;
  private cronJobs: Map<string, Cron> = new Map();
  private handlers: Map<string, JobHandler> = new Map();
  private timers: Set<NodeJS.Timeout> = new Set();

  constructor(db: Database) {
    this.db = db;
  }

  // Регистрация кастомного обработчика для действия
  registerHandler(action: string, handler: JobHandler): void {
    this.handlers.set(action, handler);
  }

  // Запуск планировщика: загрузка и запуск задач из БД
  start(): void {
    const jobs = this.db.getJobs();
    for (const job of jobs) {
      if (job.enabled) {
        this.scheduleCron(job);
      }
    }
  }

  // Добавление новой задачи
  addJob(options: {
    name: string;
    cronExpression: string;
    target?: Job['target'];
    action: string;
    params?: Record<string, unknown>;
  }): Job {
    const job: Job = {
      id: randomUUID(),
      name: options.name,
      cronExpression: options.cronExpression,
      target: options.target || 'server',
      action: options.action,
      params: options.params,
      enabled: true,
    };

    this.scheduleCron(job);
    this.db.saveJob(job);
    return job;
  }

  // Ручной немедленный запуск задачи
  async triggerJob(id: string): Promise<boolean> {
    const job = this.db.getJobById(id);
    if (!job) return false;
    await this.executeJob(job);
    return true;
  }

  // Удаление задачи
  removeJob(id: string): boolean {
    const cron = this.cronJobs.get(id);
    if (cron) {
      cron.stop();
      this.cronJobs.delete(id);
    }
    return this.db.deleteJob(id);
  }

  // Список всех задач
  listJobs(): Job[] {
    return this.db.getJobs();
  }

  // Одноразовый таймер (с возможностью отмены)
  addTimer(delayMs: number, callback: () => void | Promise<void>): () => void {
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      try {
        await callback();
      } catch (err) {
        console.error('Timer execution error:', err);
      }
    }, delayMs);

    this.timers.add(timer);
    return () => {
      clearTimeout(timer);
      this.timers.delete(timer);
    };
  }

  // Остановка всех задач и таймеров
  stopAll(): void {
    for (const cron of this.cronJobs.values()) {
      cron.stop();
    }
    this.cronJobs.clear();

    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private scheduleCron(job: Job): void {
    const existing = this.cronJobs.get(job.id);
    if (existing) {
      existing.stop();
    }

    try {
      const cron = new Cron(job.cronExpression, async () => {
        await this.executeJob(job);
      });

      this.cronJobs.set(job.id, cron);

      const nextDate = cron.nextRun();
      if (nextDate) {
        job.nextRun = nextDate.getTime();
        this.db.updateJobRun(job.id, job.lastRun || 0, job.nextRun);
      }
    } catch (err) {
      console.error(`Failed to schedule job ${job.name} (${job.cronExpression}):`, err);
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const now = Date.now();
    const cron = this.cronJobs.get(job.id);
    const nextDate = cron?.nextRun();

    job.lastRun = now;
    job.nextRun = nextDate ? nextDate.getTime() : undefined;
    this.db.updateJobRun(job.id, now, job.nextRun);

    const handler = this.handlers.get(job.action);
    if (handler) {
      try {
        await handler(job);
      } catch (err) {
        console.error(`Error in handler for action ${job.action}:`, err);
      }
    }
  }
}
