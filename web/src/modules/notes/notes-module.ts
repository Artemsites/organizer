import { OrganizerModule } from '../../core/types';

export class NotesModule implements OrganizerModule {
  readonly id = 'notes';
  readonly title = 'Заметки';
  readonly icon = '📝';

  private container: HTMLElement | null = null;

  init(container: HTMLElement): void {
    this.container = container;
    this.container.innerHTML = `
      <div class="card" style="max-width: 680px;">
        <h2 style="font-size: 1.1rem; margin-bottom: 8px;">📝 Раздел заметок</h2>
        <p style="color: #94a3b8; font-size: 0.9rem; line-height: 1.6;">
          Это демонстрация второго подключенного модуля. Архитектура <code>OrganizerModule</code> 
          позволяет добавлять новые разделы (календарь, тайм-трекер, канбан) изолированно в виде отдельных классов.
        </p>
      </div>
    `;
  }

  destroy(): void {
    this.container = null;
  }
}
