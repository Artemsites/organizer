import { OrganizerModule } from '../../core/types';
import { globalEvents } from '../../core/event-bus';

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

type FilterType = 'all' | 'active' | 'completed';

export class TodosModule implements OrganizerModule {
  readonly id = 'todos';
  readonly title = 'Задачи';
  readonly icon = '✅';

  private container: HTMLElement | null = null;
  private todos: TodoItem[] = [];
  private currentFilter: FilterType = 'all';
  private readonly STORAGE_KEY = 'organizer_todos';

  constructor() {
    this.load();
  }

  badgeCount = (): number => {
    return this.todos.filter(t => !t.completed).length;
  };

  init(container: HTMLElement): void {
    this.container = container;
    this.render();
  }

  destroy(): void {
    this.container = null;
  }

  private load(): void {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      this.todos = data ? JSON.parse(data) : [
        { id: '1', text: 'Изучить архитектуру Vanilla TypeScript', completed: true, createdAt: Date.now() - 3600000 },
        { id: '2', text: 'Собрать модульный каркас Органайзера на SCSS', completed: false, createdAt: Date.now() }
      ];
    } catch {
      this.todos = [];
    }
  }

  private save(): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.todos));
    globalEvents.emit('module:badge-updated');
  }

  private getFilteredTodos(): TodoItem[] {
    if (this.currentFilter === 'active') return this.todos.filter(t => !t.completed);
    if (this.currentFilter === 'completed') return this.todos.filter(t => t.completed);
    return this.todos;
  }

  private render(): void {
    if (!this.container) return;

    const filtered = this.getFilteredTodos();
    const activeCount = this.badgeCount();

    this.container.innerHTML = `
      <div class="todo-app">
        <form class="todo-app__header" id="todo-form">
          <input 
            type="text" 
            id="todo-input" 
            class="input todo-app__input" 
            placeholder="Что нужно сделать? (Нажмите Enter)" 
            autocomplete="off"
            required
          />
          <button type="submit" class="btn btn--primary">Добавить</button>
        </form>

        <div class="todo-app__filters">
          <button type="button" class="todo-app__filter-btn ${this.currentFilter === 'all' ? 'active' : ''}" data-filter="all">Все (${this.todos.length})</button>
          <button type="button" class="todo-app__filter-btn ${this.currentFilter === 'active' ? 'active' : ''}" data-filter="active">Активные (${activeCount})</button>
          <button type="button" class="todo-app__filter-btn ${this.currentFilter === 'completed' ? 'active' : ''}" data-filter="completed">Завершенные (${this.todos.length - activeCount})</button>
        </div>

        <ul class="todo-app__list">
          ${filtered.length === 0 ? '<li class="todo-app__empty">Список пуст</li>' : ''}
          ${filtered.map(todo => `
            <li class="todo-app__item ${todo.completed ? 'completed' : ''}" data-id="${todo.id}">
              <input type="checkbox" class="todo-app__checkbox" ${todo.completed ? 'checked' : ''} />
              <span class="todo-app__text">${this.escapeHtml(todo.text)}</span>
              <button class="todo-app__delete-btn" title="Удалить">✕</button>
            </li>
          `).join('')}
        </ul>

        <div class="todo-app__footer">
          <span>Осталось невыполненных: <strong>${activeCount}</strong></span>
          ${this.todos.some(t => t.completed) ? '<button id="btn-clear-completed" class="btn btn--danger" style="font-size: 0.75rem; padding: 4px 10px;">Очистить завершенные</button>' : ''}
        </div>
      </div>
    `;

    this.bindDOMEvents();
  }

  private bindDOMEvents(): void {
    if (!this.container) return;

    // Добавление задачи
    const form = this.container.querySelector('#todo-form') as HTMLFormElement;
    const input = this.container.querySelector('#todo-input') as HTMLInputElement;

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;

      this.todos.unshift({
        id: String(Date.now()),
        text,
        completed: false,
        createdAt: Date.now()
      });

      this.save();
      this.render();
      const nextInput = this.container?.querySelector('#todo-input') as HTMLInputElement;
      nextInput?.focus();
    });

    // Фильтры
    this.container.querySelectorAll('.todo-app__filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentFilter = (btn as HTMLElement).dataset.filter as FilterType;
        this.render();
      });
    });

    // Делегирование кликов по списку (чекбокс и удаление)
    const list = this.container.querySelector('.todo-app__list');
    list?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const itemEl = target.closest('.todo-app__item') as HTMLElement;
      if (!itemEl) return;

      const todoId = itemEl.dataset.id;
      const todo = this.todos.find(t => t.id === todoId);
      if (!todo) return;

      if (target.classList.contains('todo-app__checkbox')) {
        todo.completed = (target as HTMLInputElement).checked;
        this.save();
        this.render();
      } else if (target.classList.contains('todo-app__delete-btn')) {
        this.todos = this.todos.filter(t => t.id !== todoId);
        this.save();
        this.render();
      }
    });

    // Очистить завершенные
    this.container.querySelector('#btn-clear-completed')?.addEventListener('click', () => {
      this.todos = this.todos.filter(t => !t.completed);
      this.save();
      this.render();
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
