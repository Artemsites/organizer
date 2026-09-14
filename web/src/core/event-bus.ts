import { EventCallback } from './types';

/**
 * Легковесный типизированный EventBus для взаимодействия модулей без жесткой связности
 */
export class EventBus extends EventTarget {
  on<T = any>(event: string, callback: EventCallback<T>): () => void {
    const handler = (e: Event) => callback((e as CustomEvent<T>).detail);
    this.addEventListener(event, handler);
    return () => this.removeEventListener(event, handler);
  }

  emit<T = any>(event: string, data?: T): void {
    this.dispatchEvent(new CustomEvent(event, { detail: data }));
  }
}

export const globalEvents = new EventBus();
