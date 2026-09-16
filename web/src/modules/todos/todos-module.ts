// ==============================================================================
// TODOS MODULE (todos-module.ts)
// ==============================================================================
// Programmer Terms & Best Practices:
// 1. SSoT (Single Source of Truth):
//    Единый источник истины — база данных ядра (SQLite) через REST API.
//    Локальное хранилище 'localStorage' полностью исключено.
// 2. Event Delegation (Делегирование событий):
//    Вместо навешивания N слушателей на каждый элемент списка, вешаем ровно один
//    слушатель на родительский контейнер (<ul>). Это экономит память и не требует
//    перенавешивания обработчиков при добавлении/удалении элементов.
// 3. Targeted DOM Mutation vs Layout Thrashing:
//    Отказ от полной перерисовки через 'innerHTML = ...' при каждом действии.
//    Полный сброс сбивает фокус ввода, скролл и ломает CSS-переходы (Transitions).
//    Мутируем только конкретный <li> через classList/remove/prepend.
// 4. Optimistic UI with Rollback:
//    Синхронно обновляем DOM и UI до сетевого запроса (0ms latency perception).
//    В случае сетевой ошибки (Rejected Promise) откатываем состояние к снимку.
// 5. Chrome Event Loop Timing:
//    DOM-мутация обязана происходить ДО ключевого слова 'await'.
//    Синхронный код успевает передать изменения в текущую фазу Render (Layout & Paint)
//    до того, как сетевой промис перейдёт в очередь Microtasks / Macrotasks.
// 6. XSS Prevention (Cross-Site Scripting):
//    Все пользовательские строки (title, description) перед вставкой в разметку
//    экранируются через escapeHtml.
// 7. Lifecycle & Resource Teardown:
//    Метод 'destroy()' отменяет висящие fetch-запросы через AbortController и
//    очищает слушатели, предотвращая утечки памяти (Memory Leaks).
// ==============================================================================

import { OrganizerModule } from "../../core/types";
import { globalEvents } from "../../core/event-bus";
import { listTasks, createTask, patchTask, deleteTask } from "../../api/client";
import type {
  Task,
  TaskStatus,
  TaskPriority,
  CreateTaskDto,
} from "@organizer/shared";

type FilterType = "all" | "todo" | "in_progress" | "review" | "done";

export class TodosModule implements OrganizerModule {
  readonly id = "todos";
  readonly title = "Задачи";
  readonly icon = "✅";

  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private formEl: HTMLFormElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private prioritySelectEl: HTMLSelectElement | null = null;
  private errorNoticeEl: HTMLElement | null = null;
  private footerCountEl: HTMLElement | null = null;

  // In-memory Snapshot (кэш для мгновенного отката и подсчёта badge)
  private tasksMap = new Map<string, Task>();
  private currentFilter: FilterType = "all";

  // Один AbortController на всё: висящие fetch и все DOM-слушатели.
  // Слушатели вешаются через addEventListener(..., { signal }) — один abort()
  // в destroy() снимает их все разом, нативно, без ручного учёта ссылок.
  // (Ручной removeEventListener на 4 слушателя уже терял один — см. 7b.1.3.)
  private abortController = new AbortController();

  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Один проход по Map для всех счётчиков: badge, фильтры, футер.
   * Раньше badgeCount() и updateCounters() шли дважды по тем же данным.
   */
  private statusCounts(): {
    all: number;
    todo: number;
    in_progress: number;
    review: number;
    done: number;
    archived: number;
  } {
    const counts = { all: 0, todo: 0, in_progress: 0, review: 0, done: 0, archived: 0 };
    for (const task of this.tasksMap.values()) {
      counts.all++;
      switch (task.status) {
        case "todo":
        case "in_progress":
        case "review":
          counts[task.status]++;
          break;
        case "done":
          counts.done++;
          break;
        case "archived":
          counts.archived++;
          break;
        case "backlog":
          break;
      }
    }
    return counts;
  }

  /**
   * Бейдж вкладки: все, кроме done и archived (backlog входит).
   */
  badgeCount = (): number => {
    const counts = this.statusCounts();
    return counts.all - counts.done - counts.archived;
  };

  /**
   * Синхронная инициализация: немедленный рендер скелета разметки,
   * предотвращающий Layout Shift и мигание экрана.
   */
  init(container: HTMLElement): void {
    this.container = container;
    this.abortController = new AbortController();
    this.renderSkeleton();
    this.bindDOMEvents();
    void this.load();
  }

  /**
   * Очистка ресурсов при переключении модулей (Lifecycle Teardown)
   */
  destroy(): void {
    // abort() снимает и fetch, и все слушатели с этим signal — unbind не нужен
    this.abortController.abort();
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
    this.tasksMap.clear();
    this.container = null;
    this.listEl = null;
    this.formEl = null;
    this.inputEl = null;
    this.prioritySelectEl = null;
    this.errorNoticeEl = null;
    this.footerCountEl = null;
  }

  /**
   * Асинхронная загрузка задач из SQLite ядра
   */
  private async load(): Promise<void> {
    if (!this.listEl) return;

    this.listEl.innerHTML =
      '<li class="todo-app__empty">Загрузка задач...</li>';

    try {
      // SSoT-фильтр: todos — ровно 4 статуса (spec.md §2). backlog/archived —
      // отдельные представления (Шаги 9/10). Фильтрует сервер одним запросом (7a).
      const tasks = await listTasks(
        ['todo', 'in_progress', 'review', 'done'],
        this.abortController.signal,
      );
      if (this.abortController.signal.aborted) return;

      this.tasksMap.clear();
      for (const task of tasks) {
        // Defensive Copying: создаем независимую копию объекта,
        // чтобы мутации статуса в UI не протекали в исходные ссылки снаружи.
        this.tasksMap.set(task.id, { ...task });
      }

      this.renderList();
      this.updateCounters();
      globalEvents.emit("module:badge-updated");
    } catch (err: any) {
      if (this.abortController.signal.aborted) return;
      this.showError(
        `Ошибка загрузки задач: ${err?.message || "Сервер недоступен"}`,
      );
      if (this.listEl) {
        this.listEl.innerHTML =
          '<li class="todo-app__empty todo-app__empty--error">Не удалось загрузить задачи</li>';
      }
    }
  }

  /**
   * Создание базового каркаса (Skeleton UI)
   */
  private renderSkeleton(): void {
    if (!this.container) return;

    this.container.innerHTML = `
      <div class="todo-app">
        <div class="todo-app__error-notice" id="todo-error-notice" style="display: none;"></div>

        <form class="todo-app__header" id="todo-form">
          <input 
            type="text" 
            id="todo-input" 
            class="input todo-app__input" 
            placeholder="Что нужно сделать? (Нажмите Enter)" 
            autocomplete="off"
            required
          />
          <select id="todo-priority" class="input todo-app__select" title="Приоритет">
            <option value="medium">Обычный</option>
            <option value="low">Низкий</option>
            <option value="high">Срочный</option>
          </select>
          <button type="submit" class="btn btn--primary">Добавить</button>
        </form>

        <div class="todo-app__filters" id="todo-filters">
          <button type="button" class="todo-app__filter-btn active" data-filter="all">Все (0)</button>
          <button type="button" class="todo-app__filter-btn" data-filter="todo">К выполнению (0)</button>
          <button type="button" class="todo-app__filter-btn" data-filter="in_progress">В работе (0)</button>
          <button type="button" class="todo-app__filter-btn" data-filter="review">На проверке (0)</button>
          <button type="button" class="todo-app__filter-btn" data-filter="done">Завершено (0)</button>
        </div>

        <ul class="todo-app__list" id="todo-list">
          <li class="todo-app__empty">Список пуст</li>
        </ul>

        <div class="todo-app__footer">
          <span id="todo-footer-counters">Осталось невыполненных: <strong>0</strong></span>
        </div>
      </div>
    `;

    this.listEl = this.container.querySelector("#todo-list");
    this.formEl = this.container.querySelector("#todo-form");
    this.inputEl = this.container.querySelector("#todo-input");
    this.prioritySelectEl = this.container.querySelector("#todo-priority");
    this.errorNoticeEl = this.container.querySelector("#todo-error-notice");
    this.footerCountEl = this.container.querySelector("#todo-footer-counters");
  }

  /**
   * Подписка на события с использованием Event Delegation
   */
  private bindDOMEvents(): void {
    if (!this.container || !this.formEl || !this.listEl) return;

    // 1. Обработчик отправки формы (Создание задачи)
    const formSubmitListener = async (e: SubmitEvent) => {
      e.preventDefault();
      const title = this.inputEl?.value.trim();
      const priority =
        (this.prioritySelectEl?.value as TaskPriority) || "medium";
      if (!title) return;

      const dto: CreateTaskDto = {
        title,
        priority,
        status: "todo",
      };

      // OPTIMISTIC CREATE: всё синхронное — строго до первого await.
      // Event loop (Chrome): 'submit' — macrotask; код до await бежит в ней же,
      // и браузер рисует кадр с карточкой сразу. Продолжение после await —
      // microtask, в этот кадр она уже не попадает. Вставка ПОСЛЕ await
      // (как было раньше) — это pessimistic: юзер ждёт круг сети.
      // rAF здесь не нужен — одна вставка за событие, не цикл.
      const tempId = `temp-${crypto.randomUUID()}`;
      const now = Date.now();
      const optimisticTask: Task = {
        id: tempId,
        title,
        priority,
        status: "todo",
        createdAt: now,
        updatedAt: now,
      };
      this.tasksMap.set(tempId, optimisticTask);

      // Targeted DOM Mutation: вставляем в начало списка без полной перерисовки
      if (this.listEl) {
        this.listEl.querySelector(".todo-app__empty")?.remove();

        if (this.currentFilter === "all" || this.currentFilter === "todo") {
          this.listEl.insertAdjacentHTML(
            "afterbegin",
            this.renderItemHtml(optimisticTask),
          );
        }
      }

      if (this.inputEl) {
        this.inputEl.value = "";
        this.inputEl.focus();
      }

      this.updateCounters();
      globalEvents.emit("module:badge-updated");

      try {
        const createdTask = await createTask(dto, this.abortController.signal);
        if (this.abortController.signal.aborted) return;
        // Заменяем временный id серверным без пересоздания узла:
        // transitions, фокус и скролл не страдают.
        this.tasksMap.delete(tempId);
        this.tasksMap.set(createdTask.id, createdTask);
        const tempEl = this.listEl?.querySelector(`[data-id="${tempId}"]`);
        if (tempEl) {
          (tempEl as HTMLElement).dataset.id = createdTask.id;
          const textEl = tempEl.querySelector(".todo-app__text");
          if (textEl) textEl.textContent = createdTask.title;
        }
      } catch (err: any) {
        // Rollback вставки: убираем карточку, при пустоте возвращаем плейсхолдер
        this.tasksMap.delete(tempId);
        if (this.listEl) {
          this.listEl.querySelector(`[data-id="${tempId}"]`)?.remove();
          if (this.listEl.children.length === 0) {
            this.listEl.innerHTML =
              '<li class="todo-app__empty">Список пуст</li>';
          }
        }
        this.updateCounters();
        globalEvents.emit("module:badge-updated");
        this.showError(
          `Не удалось создать задачу: ${err?.message || "Ошибка сети"}`,
        );
      }
    };
    this.formEl.addEventListener("submit", formSubmitListener, {
      signal: this.abortController.signal,
    });

    // 2. Делегирование событий изменения чекбокса (Optimistic UI)
    const listChangeListener = async (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("todo-app__checkbox")) return;

      const itemEl = target.closest(".todo-app__item") as HTMLElement;
      if (!itemEl) return;

      const taskId = itemEl.dataset.id;
      if (!taskId) return;

      const task = this.tasksMap.get(taskId);
      if (!task) return;

      const prevStatus = task.status;
      const isChecked = (target as HTMLInputElement).checked;
      const newStatus: TaskStatus = isChecked ? "done" : "todo";

      // ==========================================================================
      // OPTIMISTIC UI (Синхронная мутация DOM до await):
      // Пользователь видит отклик анимации мгновенно (0ms). Браузер запускает
      // CSS-transition на GPU. Мы сохраняем ссылку на элемент, исключая пересоздание.
      // ==========================================================================
      task.status = newStatus;
      itemEl.classList.toggle("completed", isChecked);
      this.updateCounters();
      globalEvents.emit("module:badge-updated");

      try {
        await patchTask(
          taskId,
          { status: newStatus },
          this.abortController.signal,
        );
      } catch (err: any) {
        // ========================================================================
        // ROLLBACK PATTERN (Откат в случае сетевой ошибки):
        // Возвращаем исходный статус в памяти и в DOM-дереве.
        // ========================================================================
        task.status = prevStatus;
        (target as HTMLInputElement).checked = prevStatus === "done";
        itemEl.classList.toggle("completed", prevStatus === "done");
        this.updateCounters();
        globalEvents.emit("module:badge-updated");
        this.showError(
          `Ошибка сохранения: ${err?.message || "Статус не обновлен на сервере"}`,
        );
      }
    };
    this.listEl.addEventListener("change", listChangeListener, {
      signal: this.abortController.signal,
    });

    // 3. Делегирование кликов по кнопке удаления
    const listClickListener = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest(".todo-app__delete-btn");
      if (!deleteBtn) return;

      const itemEl = target.closest(".todo-app__item") as HTMLElement;
      if (!itemEl) return;

      const taskId = itemEl.dataset.id;
      if (!taskId) return;

      const task = this.tasksMap.get(taskId);
      if (!task) return;

      // Optimistic Delete: удаляем из памяти и из DOM.
      // Запоминаем соседа, чтобы откат вернул узел на то же место,
      // а не в конец списка (Map.set дописывает в хвост).
      const nextSibling = itemEl.nextElementSibling;
      this.tasksMap.delete(taskId);
      itemEl.remove();
      if (this.listEl && this.listEl.children.length === 0) {
        this.listEl.innerHTML = '<li class="todo-app__empty">Список пуст</li>';
      }
      this.updateCounters();
      globalEvents.emit("module:badge-updated");

      try {
        await deleteTask(taskId, this.abortController.signal);
      } catch (err: any) {
        // Rollback in place: узел возвращается к сохранённому соседу.
        // renderList() здесь нельзя — он сбросит порядок и убьёт transitions.
        this.tasksMap.set(taskId, task);
        if (this.listEl) {
          this.listEl.querySelector(".todo-app__empty")?.remove();
          if (nextSibling && nextSibling.isConnected) {
            this.listEl.insertBefore(itemEl, nextSibling);
          } else {
            this.listEl.appendChild(itemEl);
          }
        }
        this.updateCounters();
        globalEvents.emit("module:badge-updated");
        this.showError(
          `Не удалось удалить задачу: ${err?.message || "Ошибка сети"}`,
        );
      }
    };
    this.listEl.addEventListener("click", listClickListener, {
      signal: this.abortController.signal,
    });

    // 4. Фильтры статусов
    const filterContainer = this.container.querySelector("#todo-filters");
    const filterClickListener = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest(
        ".todo-app__filter-btn",
      ) as HTMLButtonElement;
      if (!btn) return;

      const filter = btn.dataset.filter as FilterType;
      if (filter === this.currentFilter) return;

      this.currentFilter = filter;
      filterContainer
        ?.querySelectorAll(".todo-app__filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      this.renderList();
    };
    filterContainer?.addEventListener("click", filterClickListener, {
      signal: this.abortController.signal,
    });
  }

  /**
   * Отрисовка списка задач согласно выбранному фильтру
   */
  private renderList(): void {
    if (!this.listEl) return;

    const tasks = Array.from(this.tasksMap.values());
    const filtered = tasks.filter((t) => {
      if (this.currentFilter === "all") return true;
      return t.status === this.currentFilter;
    });

    if (filtered.length === 0) {
      this.listEl.innerHTML = '<li class="todo-app__empty">Список пуст</li>';
      return;
    }

    this.listEl.innerHTML = filtered
      .map((t) => this.renderItemHtml(t))
      .join("");
  }

  /**
   * Рендер отдельного элемента <li>
   */
  private renderItemHtml(todo: Task): string {
    const isCompleted = todo.status === "done";
    const safeTitle = this.escapeHtml(todo.title);
    const priority = todo.priority || "medium";

    return `
      <li class="todo-app__item ${isCompleted ? "completed" : ""}" data-id="${this.escapeHtml(todo.id)}">
        <input 
          type="checkbox" 
          class="todo-app__checkbox" 
          ${isCompleted ? "checked" : ""} 
          aria-label="Отметить задачу '${safeTitle}'"
        />
        <span class="todo-app__text">${safeTitle}</span>
        <span class="todo-app__priority todo-app__priority--${priority}">${this.priorityLabel(priority)}</span>
        <button class="todo-app__delete-btn" title="Удалить задачу" aria-label="Удалить">✕</button>
      </li>
    `;
  }

  /**
   * Обновление числовых показателей на кнопках фильтра и в футере
   */
  private updateCounters(): void {
    if (!this.container) return;

    const counts = this.statusCounts();

    const filterBtns = this.container.querySelectorAll(".todo-app__filter-btn");
    filterBtns.forEach((btn) => {
      const filter = (btn as HTMLElement).dataset.filter as FilterType;
      if (filter === "all") btn.textContent = `Все (${counts.all})`;
      else if (filter === "todo")
        btn.textContent = `К выполнению (${counts.todo})`;
      else if (filter === "in_progress")
        btn.textContent = `В работе (${counts.in_progress})`;
      else if (filter === "review")
        btn.textContent = `На проверке (${counts.review})`;
      else if (filter === "done")
        btn.textContent = `Завершено (${counts.done})`;
    });

    const activeCount = counts.todo + counts.in_progress + counts.review;
    if (this.footerCountEl) {
      this.footerCountEl.innerHTML = `Осталось невыполненных: <strong>${activeCount}</strong>`;
    }
  }

  /**
   * Всплывающее предупреждение об ошибке
   */
  private showError(message: string): void {
    if (!this.errorNoticeEl) return;
    this.errorNoticeEl.textContent = message;
    this.errorNoticeEl.style.display = "block";

    // Один живой таймер: новый показ гасит предыдущий, destroy() — все.
    // Иначе второе сообщение гаснет по таймеру первого.
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      if (this.errorNoticeEl) {
        this.errorNoticeEl.style.display = "none";
      }
    }, 4000);
  }

  private priorityLabel(priority: TaskPriority): string {
    switch (priority) {
      case "high":
        return "Срочно";
      case "low":
        return "Низкий";
      case "medium":
      default:
        return "Обычный";
    }
  }

  /**
   * Защита от XSS-инъекций при интерполяции строк
   *
   * Best Practice: pure string replace, без DOM-узла на вызов.
   * Раньше создавался <div> на каждый вызов (по 2 на карточку в renderList).
   * Порядок: сначала & — иначе свои же &lt; превратятся в &amp;lt;.
   * Кавычки обязательны: текст идёт и в атрибут aria-label="..." (stored XSS).
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
}
