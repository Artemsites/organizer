import { OrganizerModule } from './types';
import { globalEvents } from './event-bus';

/**
 * AppShell — каркас приложения, управляющий навигацией и жизненным циклом модулей
 */
export class AppShell {
  private modules: Map<string, OrganizerModule> = new Map();
  private currentModuleId: string | null = null;
  private container: HTMLElement;
  private sidebarElement!: HTMLElement;
  private backdropElement!: HTMLElement;
  private menuToggleBtn!: HTMLElement;
  private navContainer!: HTMLElement;
  private contentContainer!: HTMLElement;
  private titleElement!: HTMLElement;

  constructor(rootElement: HTMLElement) {
    this.container = rootElement;
    this.renderLayout();
    this.bindEvents();
  }

  private renderLayout(): void {
    this.container.innerHTML = `
      <div class="app-shell">
        <div class="sidebar__backdrop" id="sidebar-backdrop"></div>
        <aside class="sidebar" id="sidebar">
          <div class="sidebar__brand">
            <span class="brand-icon sidebar__brand-icon">⚡</span>
            <span>Органайзер</span>
          </div>
          <nav class="sidebar__nav" id="sidebar-nav"></nav>
          <div class="sidebar__footer">
            <span>Vanilla TS + SCSS</span>
          </div>
        </aside>
        <main class="main-area">
          <header class="top-bar">
            <div class="top-bar__left">
              <button
                id="menu-toggle"
                class="top-bar__menu-btn"
                type="button"
                aria-label="Переключить навигационное меню"
                aria-expanded="false"
                aria-controls="sidebar"
              >☰</button>
              <h1 class="top-bar__title" id="module-title">Загрузка...</h1>
            </div>
            <div class="top-bar__meta">Нативный DOM API • Модульная архитектура</div>
          </header>
          <section class="module-container" id="module-content"></section>
        </main>
      </div>
    `;

    this.sidebarElement = this.container.querySelector('#sidebar')!;
    this.backdropElement = this.container.querySelector('#sidebar-backdrop')!;
    this.menuToggleBtn = this.container.querySelector('#menu-toggle')!;
    this.navContainer = this.container.querySelector('#sidebar-nav')!;
    this.contentContainer = this.container.querySelector('#module-content')!;
    this.titleElement = this.container.querySelector('#module-title')!;
  }

  private bindEvents(): void {
    globalEvents.on('module:badge-updated', () => {
      this.updateBadges();
    });

    // Best Practice: Управление Off-Canvas Drawer (выездной панелью)
    this.menuToggleBtn.addEventListener('click', () => {
      this.toggleSidebar();
    });

    this.backdropElement.addEventListener('click', () => {
      this.closeSidebar();
    });

    // Best Practice (a11y): Закрытие оверлея по клавише Escape
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape' && this.isSidebarOpen()) {
        this.closeSidebar();
      }
    });
  }

  isSidebarOpen(): boolean {
    return this.sidebarElement.classList.contains('sidebar--open');
  }

  toggleSidebar(isOpen?: boolean): void {
    const shouldOpen = isOpen !== undefined ? isOpen : !this.isSidebarOpen();
    this.sidebarElement.classList.toggle('sidebar--open', shouldOpen);
    this.backdropElement.classList.toggle('sidebar__backdrop--visible', shouldOpen);
    this.menuToggleBtn.setAttribute('aria-expanded', String(shouldOpen));
  }

  closeSidebar(): void {
    this.toggleSidebar(false);
  }

  registerModule(module: OrganizerModule): void {
    this.modules.set(module.id, module);
    this.renderNavItem(module);

    // Если это первый зарегистрированный модуль — открываем его
    if (!this.currentModuleId) {
      this.switchModule(module.id);
    }
  }

  private renderNavItem(module: OrganizerModule): void {
    const item = document.createElement('div');
    item.className = 'sidebar__item';
    item.dataset.moduleId = module.id;
    item.innerHTML = `
      <span class="item-icon sidebar__item-icon">${module.icon}</span>
      <span class="item-title sidebar__item-title">${module.title}</span>
      <span class="badge sidebar__badge" id="badge-${module.id}"></span>
    `;

    item.addEventListener('click', () => {
      this.switchModule(module.id);
    });

    this.navContainer.appendChild(item);
    this.updateBadgeForModule(module);
  }

  switchModule(moduleId: string): void {
    if (this.currentModuleId === moduleId) return;

    // Уничтожение предыдущего активного модуля
    if (this.currentModuleId) {
      const prevModule = this.modules.get(this.currentModuleId);
      prevModule?.destroy?.();
    }

    const nextModule = this.modules.get(moduleId);
    if (!nextModule) return;

    this.currentModuleId = moduleId;
    this.titleElement.textContent = `${nextModule.icon} ${nextModule.title}`;

    // Переключение активного класса в сайдбаре
    this.navContainer.querySelectorAll('.sidebar__item').forEach(el => {
      const item = el as HTMLElement;
      item.classList.toggle('active', item.dataset.moduleId === moduleId);
    });

    // Очистка контейнера и инициализация нового модуля
    this.contentContainer.innerHTML = '';
    nextModule.init(this.contentContainer);

    // Автоматически скрываем мобильный Drawer после выбора модуля
    if (this.isSidebarOpen()) {
      this.closeSidebar();
    }

    this.updateBadges();
  }

  private updateBadges(): void {
    this.modules.forEach(mod => this.updateBadgeForModule(mod));
  }

  private updateBadgeForModule(module: OrganizerModule): void {
    const badgeEl = this.container.querySelector(`#badge-${module.id}`);
    if (!badgeEl) return;

    if (module.badgeCount) {
      const count = module.badgeCount();
      badgeEl.textContent = count > 0 ? String(count) : '';
      (badgeEl as HTMLElement).style.display = count > 0 ? 'inline-block' : 'none';
    } else {
      (badgeEl as HTMLElement).style.display = 'none';
    }
  }
}
