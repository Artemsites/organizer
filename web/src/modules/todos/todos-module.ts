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

import { OrganizerModule } from '../../core/types';
import { globalEvents } from '../../core/event-bus';
import { listTasks, createTask, patchTask, deleteTask } from '../../api/client';
import type { Task, TaskStatus, TaskPriority, CreateTaskDto } from '@organizer/shared';

type FilterType = 'all' | 'todo' | 'in_progress' | 'review' | 'done';

export class TodosModule implements OrganizerModule {
  readonly id = 'todos';
  readonly title = 'Задачи';
  readonly icon = '✅';

  private container: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private formEl: HTMLFormElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private prioritySelectEl: HTMLSelectElement | null = null;
  private errorNoticeEl: HTMLElement | null = null;
  private footerCountEl: HTMLElement | null = null;

  // In-memory Snapshot (кэш для мгновенного отката и подсчёта badge)
  private tasksMap = new Map<string, Task>();
  private currentFilter: FilterType = 'all';

  // Один AbortController на всё: висящие fetch и все DOM-слушатели.
  // Слушатели вешаются через addEventListener(..., { signal }) — один abort()
  // в destroy() снимает их все разом, нативно, без ручного учёта ссылок.
  // (Ручной removeEventListener на 4 слушателя уже терял один — см. 7b.1.3.)
  private abortController = new AbortController();

  /**
   * Подсчет бейджа на вкладке сайдбара:
   * Считаем только активные задачи (не 'done' и не 'archived').
   */
  badgeCount = (): number => {
    let count = 0;
    for (const task of this.tasksMap.values()) {
      if (task.status !== 'done' && task.status !== 'archived') {
        count++;
      }
    }
    return count;
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

    this.listEl.innerHTML = '<li class="todo-app__empty">Загрузка задач...</li>';

    try {
      const tasks = await listTasks(undefined, this.abortController.signal);
      if (this.abortController.signal.aborted) return;

      this.tasksMap.clear();
      for (const task of tasks) {
        // Defensive Copying: создаем независимую копию объекта,
        // чтобы мутации статуса в UI не протекали в исходные ссылки снаружи.
        this.tasksMap.set(task.id, { ...task });
      }

      this.renderList();
      this.updateCounters();
      globalEvents.emit('module:badge-updated');
    } catch (err: any) {
      if (this.abortController.signal.aborted) return;
      this.showError(`Ошибка загрузки задач: ${err?.message || 'Сервер недоступен'}`);
      if (this.listEl) {
        this.listEl.innerHTML = '<li class="todo-app__empty todo-app__empty--error">Не удалось загрузить задачи</li>';
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

    this.listEl = this.container.querySelector('#todo-list');
    this.formEl = this.container.querySelector('#todo-form');
    this.inputEl = this.container.querySelector('#todo-input');
    this.prioritySelectEl = this.container.querySelector('#todo-priority');
    this.errorNoticeEl = this.container.querySelector('#todo-error-notice');
    this.footerCountEl = this.container.querySelector('#todo-footer-counters');
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
      const priority = (this.prioritySelectEl?.value as TaskPriority) || 'medium';
      if (!title) return;

      const dto: CreateTaskDto = {
        title,
        priority,
        status: 'todo',
      };

      try {
        const createdTask = await createTask(dto, this.abortController.signal);
        this.tasksMap.set(createdTask.id, createdTask);

        // Targeted DOM Mutation: вставляем в начало списка без полной перерисовки
        if (this.listEl) {
          const emptyPlaceholder = this.listEl.querySelector('.todo-app__empty');
          if (emptyPlaceholder) {
            emptyPlaceholder.remove();
          }

          if (this.currentFilter === 'all' || this.currentFilter === 'todo') {
            this.listEl.insertAdjacentHTML('afterbegin', this.renderItemHtml(createdTask));
          }
        }

        if (this.inputEl) {
          this.inputEl.value = '';
          this.inputEl.focus();
        }

        this.updateCounters();
        globalEvents.emit('module:badge-updated');
      } catch (err: any) {
        this.showError(`Не удалось создать задачу: ${err?.message || 'Ошибка сети'}`);
      }
    };
    this.formEl.addEventListener('submit', formSubmitListener, { signal: this.abortController.signal });

    // 2. Делегирование событий изменения чекбокса (Optimistic UI)
    const listChangeListener = async (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('todo-app__checkbox')) return;

      const itemEl = target.closest('.todo-app__item') as HTMLElement;
      if (!itemEl) return;

      const taskId = itemEl.dataset.id;
      if (!taskId) return;

      const task = this.tasksMap.get(taskId);
      if (!task) return;

      const prevStatus = task.status;
      const isChecked = (target as HTMLInputElement).checked;
      const newStatus: TaskStatus = isChecked ? 'done' : 'todo';

      // ==========================================================================
      // OPTIMISTIC UI (Синхронная мутация DOM до await):
      // Пользователь видит отклик анимации мгновенно (0ms). Браузер запускает
      // CSS-transition на GPU. Мы сохраняем ссылку на элемент, исключая пересоздание.
      // ==========================================================================
      task.status = newStatus;
      itemEl.classList.toggle('completed', isChecked);
      this.updateCounters();
      globalEvents.emit('module:badge-updated');

      try {
        await patchTask(taskId, { status: newStatus }, this.abortController.signal);
      } catch (err: any) {
        // ========================================================================
        // ROLLBACK PATTERN (Откат в случае сетевой ошибки):
        // Возвращаем исходный статус в памяти и в DOM-дереве.
        // ========================================================================
        task.status = prevStatus;
        (target as HTMLInputElement).checked = prevStatus === 'done';
        itemEl.classList.toggle('completed', prevStatus === 'done');
        this.updateCounters();
        globalEvents.emit('module:badge-updated');
        this.showError(`Ошибка сохранения: ${err?.message || 'Статус не обновлен на сервере'}`);
      }
    };
    this.listEl.addEventListener('change', listChangeListener, { signal: this.abortController.signal });

    // 3. Делегирование кликов по кнопке удаления
    const listClickListener = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest('.todo-app__delete-btn');
      if (!deleteBtn) return;

      const itemEl = target.closest('.todo-app__item') as HTMLElement;
      if (!itemEl) return;

      const taskId = itemEl.dataset.id;
      if (!taskId) return;

      const task = this.tasksMap.get(taskId);
      if (!task) return;

      // Optimistic Delete: удаляем из памяти и из DOM
      this.tasksMap.delete(taskId);
      itemEl.remove();
      if (this.listEl && this.listEl.children.length === 0) {
        this.listEl.innerHTML = '<li class="todo-app__empty">Список пуст</li>';
      }
      this.updateCounters();
      globalEvents.emit('module:badge-updated');

      try {
        await deleteTask(taskId, this.abortController.signal);
      } catch (err: any) {
        // Rollback: возвращаем задачу в кэш и в список
        this.tasksMap.set(taskId, task);
        this.renderList();
        this.updateCounters();
        globalEvents.emit('module:badge-updated');
        this.showError(`Не удалось удалить задачу: ${err?.message || 'Ошибка сети'}`);
      }
    };
    this.listEl.addEventListener('click', listClickListener, { signal: this.abortController.signal });

    // 4. Фильтры статусов
    const filterContainer = this.container.querySelector('#todo-filters');
    const filterClickListener = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('.todo-app__filter-btn') as HTMLButtonElement;
      if (!btn) return;

      const filter = btn.dataset.filter as FilterType;
      if (filter === this.currentFilter) return;

      this.currentFilter = filter;
      filterContainer?.querySelectorAll('.todo-app__filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      this.renderList();
    };
    filterContainer?.addEventListener('click', filterClickListener, { signal: this.abortController.signal });
  }

  /**
   * Отрисовка списка задач согласно выбранному фильтру
   */
  private renderList(): void {
    if (!this.listEl) return;

    const tasks = Array.from(this.tasksMap.values());
    const filtered = tasks.filter(t => {
      if (this.currentFilter === 'all') return true;
      return t.status === this.currentFilter;
    });

    if (filtered.length === 0) {
      this.listEl.innerHTML = '<li class="todo-app__empty">Список пуст</li>';
      return;
    }

    this.listEl.innerHTML = filtered.map(t => this.renderItemHtml(t)).join('');
  }

  /**
   * Рендер отдельного элемента <li>
   */
  private renderItemHtml(todo: Task): string {
    const isCompleted = todo.status === 'done';
    const safeTitle = this.escapeHtml(todo.title);
    const priority = todo.priority || 'medium';

    return `
      <li class="todo-app__item ${isCompleted ? 'completed' : ''}" data-id="${this.escapeHtml(todo.id)}">
        <input 
          type="checkbox" 
          class="todo-app__checkbox" 
          ${isCompleted ? 'checked' : ''} 
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

    const tasks = Array.from(this.tasksMap.values());
    const counts = {
      all: tasks.length,
      todo: 0,
      in_progress: 0,
      review: 0,
      done: 0,
    };

    for (const t of tasks) {
      if (t.status === 'todo') counts.todo++;
      else if (t.status === 'in_progress') counts.in_progress++;
      else if (t.status === 'review') counts.review++;
      else if (t.status === 'done') counts.done++;
    }

    const filterBtns = this.container.querySelectorAll('.todo-app__filter-btn');
    filterBtns.forEach(btn => {
      const filter = (btn as HTMLElement).dataset.filter as FilterType;
      if (filter === 'all') btn.textContent = `Все (${counts.all})`;
      else if (filter === 'todo') btn.textContent = `К выполнению (${counts.todo})`;
      else if (filter === 'in_progress') btn.textContent = `В работе (${counts.in_progress})`;
      else if (filter === 'review') btn.textContent = `На проверке (${counts.review})`;
      else if (filter === 'done') btn.textContent = `Завершено (${counts.done})`;
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
    this.errorNoticeEl.style.display = 'block';

    setTimeout(() => {
      if (this.errorNoticeEl) {
        this.errorNoticeEl.style.display = 'none';
      }
    }, 4000);
  }

  private priorityLabel(priority: TaskPriority): string {
    switch (priority) {
      case 'high': return 'Срочно';
      case 'low': return 'Низкий';
      case 'medium':
      default: return 'Обычный';
    }
  }

  /**
   * Защита от XSS-инъекций при интерполяции строк
   *
   * Best Practice: HTML Entity Encoding in one place (SSoT).
   * div.textContent → div.innerHTML уже экранирует &, <, >.
   * Кавычки в текстовом узле безопасны, поэтому сериализация их пропускает,
   * но в атрибуте (aria-label="...") кавычка разрывает значение — stored XSS.
   * Добиваем только " и '. Повторно & не трогаем: сущности из innerHTML
   * (напр. &lt;) иначе превратятся в &amp;lt; (double-encoding).
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
}
