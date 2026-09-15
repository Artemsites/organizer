import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../src/db/index.js';
import type { TaskStatus } from '@organizer/shared';

/**
 * ENGLISH: State Machine — задача проходит фиксированный набор состояний.
 * Negative Testing — прямой INSERT в обход API, чтобы доказать CHECK в SQLite.
 * Regression — фильтр IN одним запросом, иначе 7b сделает N запросов (N+1).
 */
describe('жизненный цикл, фильтр и CHECK статусов задач', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('полный жизненный цикл backlog → todo → in_progress → review → done → archived, на каждом шаге updatedAt растёт', () => {
    // Date.now() в миллисекундах: без mock два update в одном ms дадут одинаковый updatedAt.
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const created = db.createTask({ title: 'Lifecycle', status: 'backlog' });
    expect(created.status).toBe('backlog');

    const lifecycle: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'archived'];
    let prev = created.updatedAt;

    for (const status of lifecycle) {
      now += 1;
      const updated = db.updateTask(created.id, { status });
      expect(updated?.status).toBe(status);
      expect(updated!.updatedAt).toBeGreaterThan(prev);
      prev = updated!.updatedAt;
    }
  });

  it("getTasks(['todo','in_progress']) возвращает только эти статусы", () => {
    db.createTask({ title: 'todo', status: 'todo' });
    db.createTask({ title: 'doing', status: 'in_progress' });
    db.createTask({ title: 'done', status: 'done' });

    const found = db.getTasks(['todo', 'in_progress']);
    expect(found).toHaveLength(2);
    expect(found.map((t) => t.status).sort()).toEqual(['in_progress', 'todo']);
  });

  it('getTasks() без аргумента возвращает все', () => {
    db.createTask({ title: 'a', status: 'backlog' });
    db.createTask({ title: 'b', status: 'archived' });

    expect(db.getTasks()).toHaveLength(2);
  });

  it("прямой INSERT в tasks со status = 'lol' отклоняется БД", () => {
    const insert = db.db.prepare(`
      INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    expect(() => insert.run('bad-id', 'invalid', 'lol', 'medium', 1, 1)).toThrow(/CHECK/i);
  });
});
