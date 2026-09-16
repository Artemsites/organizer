// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TodosModule } from "../src/modules/todos/todos-module";
import type { Task } from "@organizer/shared";

// Мокаем API-клиент ядра, изолируя тестирование логики UI и DOM
vi.mock("../src/api/client", () => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  patchTask: vi.fn(),
  deleteTask: vi.fn(),
}));

import * as api from "../src/api/client";

describe("TodosModule: REST API, Targeted DOM, Optimistic UI", () => {
  let container: HTMLElement;
  let module: TodosModule;

  let mockTasks: Task[];

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    module = new TodosModule();

    // Test Fixture Isolation: каждый тест получает свежий изолированный набор данных
    mockTasks = [
      {
        id: "task-1",
        title: "Первая задача",
        status: "todo",
        priority: "medium",
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: "task-2",
        title: "Вторая завершенная",
        status: "done",
        priority: "high",
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];
  });

  it("init() синхронно создаёт разметку до ответа сервера", () => {
    let resolved = false;
    vi.mocked(api.listTasks).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve([]);
          }, 100);
        }),
    );

    module.init(container);

    // Каркас должен быть в DOM немедленно (0ms Layout Shift)
    expect(container.querySelector("#todo-form")).not.toBeNull();
    expect(container.querySelector("#todo-list")).not.toBeNull();
    expect(container.querySelector("#todo-filters")).not.toBeNull();
    expect(resolved).toBe(false);
  });

  it('список отображает задачи из API или состояние "список пуст"', async () => {
    vi.mocked(api.listTasks).mockResolvedValueOnce([]);

    module.init(container);
    await vi.waitFor(() => {
      const empty = container.querySelector(".todo-app__empty");
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toBe("Список пуст");
    });

    vi.mocked(api.listTasks).mockResolvedValueOnce(mockTasks);
    const container2 = document.createElement("div");
    const module2 = new TodosModule();
    module2.init(container2);

    await vi.waitFor(() => {
      const items = container2.querySelectorAll(".todo-app__item");
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain("Первая задача");
    });
  });

  it("оптимистичный UI: статус в DOM обновляется синхронно до ответа сервера", async () => {
    vi.mocked(api.listTasks).mockResolvedValueOnce([mockTasks[0]]);
    module.init(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".todo-app__item")).toHaveLength(1);
    });

    const itemEl = container.querySelector(".todo-app__item") as HTMLElement;
    const checkbox = itemEl.querySelector(
      ".todo-app__checkbox",
    ) as HTMLInputElement;

    // Подвешиваем промис, чтобы он не резолвился сразу
    let apiResolve: (val: any) => void = () => {};
    vi.mocked(api.patchTask).mockImplementation(
      () =>
        new Promise((resolve) => {
          apiResolve = resolve;
        }),
    );

    // Пользователь кликает чекбокс
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // КЛЮЧЕВОЙ ТЕСТ: DOM уже оптимистично обновлен СИНХРОННО, до ответа сети!
    expect(itemEl.classList.contains("completed")).toBe(true);
    expect(api.patchTask).toHaveBeenCalledWith("task-1", { status: "done" });

    // Завершаем промис сервера
    apiResolve({ ...mockTasks[0], status: "done" });
  });

  it("откат состояния (rollback) и показ ошибки при сбое patchTask", async () => {
    vi.mocked(api.listTasks).mockResolvedValueOnce([mockTasks[0]]);
    module.init(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".todo-app__item")).toHaveLength(1);
    });

    const itemEl = container.querySelector(".todo-app__item") as HTMLElement;
    const checkbox = itemEl.querySelector(
      ".todo-app__checkbox",
    ) as HTMLInputElement;

    // Сервер вернет ошибку (отказ сети / 500)
    vi.mocked(api.patchTask).mockRejectedValueOnce(
      new Error("Network offline"),
    );

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    // Сразу после клика — оптимистично включено
    expect(itemEl.classList.contains("completed")).toBe(true);

    // После реджекта — откат (Rollback) назад в исходное состояние
    await vi.waitFor(() => {
      expect(itemEl.classList.contains("completed")).toBe(false);
      expect(checkbox.checked).toBe(false);
      const errorEl = container.querySelector(
        "#todo-error-notice",
      ) as HTMLElement;
      expect(errorEl.style.display).not.toBe("none");
      expect(errorEl.textContent).toContain("Network offline");
    });
  });

  it("смена статуса не пересоздаёт DOM-узел <li> (сохранение ссылки для CSS transitions)", async () => {
    vi.mocked(api.listTasks).mockResolvedValueOnce([mockTasks[0]]);
    vi.mocked(api.patchTask).mockResolvedValueOnce({
      ...mockTasks[0],
      status: "done",
    });

    module.init(container);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".todo-app__item")).toHaveLength(1);
    });

    const itemBefore = container.querySelector(
      ".todo-app__item",
    ) as HTMLElement;
    const checkbox = itemBefore.querySelector(
      ".todo-app__checkbox",
    ) as HTMLInputElement;

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    const itemAfter = container.querySelector(".todo-app__item") as HTMLElement;

    // Ссылка на DOM-узел строго идентична — никакого innerHTML thrashing
    expect(itemBefore).toBe(itemAfter);
  });

  it("экранирование спецсимволов HTML в названии (защита от XSS)", async () => {
    const maliciousTask: Task = {
      id: "task-xss",
      title: '<script>alert(1)</script><img src="x" onerror="alert(2)">',
      status: "todo",
      priority: "high",
      createdAt: 3000,
      updatedAt: 3000,
    };

    vi.mocked(api.listTasks).mockResolvedValueOnce([maliciousTask]);
    module.init(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".todo-app__item")).toHaveLength(1);
    });

    const textEl = container.querySelector(".todo-app__text") as HTMLElement;
    // Текст должен содержать сырой текст без выполнения тегов скрипта
    expect(textEl.innerHTML).not.toContain("<script>");
    expect(textEl.textContent).toContain("<script>alert(1)</script>");
  });

  it("destroy() отменяет висящий запрос: signal доходит до API и aborted", async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(api.listTasks).mockImplementation(
      (_status, signal) =>
        new Promise((resolve) => {
          capturedSignal = signal;
          setTimeout(() => resolve(mockTasks), 200);
        }),
    );

    module.init(container);
    expect(capturedSignal).toBeDefined();

    module.destroy();

    // Abort реален, а не флаг: тот же объект signal теперь aborted
    expect(capturedSignal?.aborted).toBe(true);
    // Состояние модуля очищено
    expect(module.badgeCount()).toBe(0);
  });

  it("badgeCount() считает только незавершённые задачи (исключая done и archived)", async () => {
    const tasksWithArchived: Task[] = [
      {
        id: "1",
        title: "T1",
        status: "todo",
        priority: "low",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "2",
        title: "T2",
        status: "in_progress",
        priority: "medium",
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: "3",
        title: "T3",
        status: "review",
        priority: "high",
        createdAt: 3,
        updatedAt: 3,
      },
      {
        id: "4",
        title: "T4",
        status: "done",
        priority: "low",
        createdAt: 4,
        updatedAt: 4,
      },
      {
        id: "5",
        title: "T5",
        status: "archived",
        priority: "low",
        createdAt: 5,
        updatedAt: 5,
      },
    ];

    vi.mocked(api.listTasks).mockResolvedValueOnce(tasksWithArchived);
    module.init(container);

    await vi.waitFor(() => {
      expect(container.querySelectorAll(".todo-app__item")).toHaveLength(5);
    });

    // Из 5 задач активны только 3 (todo, in_progress, review)
    expect(module.badgeCount()).toBe(3);
  });

  // ============================================================================
  // Шаг 7b.1.1 — Stored XSS в aria-label: кавычка не должна разрывать атрибут
  //
  // Учебный момент: старый escapeHtml() экранирует < > & но НЕ " и '.
  // В текстовом узле HTML кавычки безопасны, но в атрибуте:
  //   aria-label="x" onfocus="alert(1)"
  // — кавычка разрывает значение атрибута и открывает дыру.
  // ============================================================================
  it("название с кавычкой не разрывает aria-label (stored XSS)", async () => {
    const xssTask: Task = {
      id: "task-xss-quote",
      title: 'x" onfocus="alert(1)" autofocus="',
      status: "todo",
      priority: "medium",
      createdAt: 9999,
      updatedAt: 9999,
    };

    vi.mocked(api.listTasks).mockResolvedValueOnce([xssTask]);
    module.init(container);

    await vi.waitFor(() => {
      const items = container.querySelectorAll(".todo-app__item");
      expect(items).toHaveLength(1);
    });

    const checkbox = container.querySelector(
      ".todo-app__checkbox",
    ) as HTMLInputElement;

    // Атрибут не разорван: лишних атрибутов нет, payload — текст внутри aria-label.
    // getAttribute возвращает декодированное значение, поэтому подстроку
    // "onfocus" искать бессмысленно — она там как текст. Проверяем структуру.
    expect(checkbox.hasAttribute("onfocus")).toBe(false);
    expect(checkbox.hasAttribute("autofocus")).toBe(false);
    expect(checkbox.getAttribute("aria-label")).toContain(
      'x" onfocus="alert(1)"',
    );
  });

  // ============================================================================
  // Шаг 7b.1.3 — detached DOM: слушатель фильтров снимается вместе с остальными.
  // Ручной removeEventListener уже терял один слушатель, поэтому teardown
  // переведён на addEventListener(..., { signal }). Тест ловит откат:
  // убери signal у подписки фильтров — клик снова двигает .active.
  // ============================================================================
  it("десять init/destroy подряд не оставляют живых слушателей фильтров", async () => {
    vi.mocked(api.listTasks).mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      module.init(container);
      module.destroy();
    }

    // Последний каркас мёртв: клик по фильтру ничего не двигает
    const todoBtn = container.querySelector(
      '[data-filter="todo"]',
    ) as HTMLButtonElement;
    todoBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(todoBtn.classList.contains("active")).toBe(false);
    expect(
      container
        .querySelector('[data-filter="all"]')
        ?.classList.contains("active"),
    ).toBe(true);
  });
});
