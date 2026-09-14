import { EventCallback } from './types';

/**
 * Легковесный типизированный EventBus для взаимодействия модулей без жесткой связности
 */
export class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

  on<T = any>(event: string, callback: EventCallback<T>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Возвращаем функцию отписки
    return () => {
      this.off(event, callback);
    };
  }

  off<T = any>(event: string, callback: EventCallback<T>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  emit<T = any>(event: string, data?: T): void {
    const set = this.listeners.get(event);
    if (set) {
      set.forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Ошибка в обработчике события "${event}":`, err);
        }
      });
    }
  }
}

export const globalEvents = new EventBus();
