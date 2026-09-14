/**
 * Базовые контракты и интерфейсы ядра органайзера
 */

export interface OrganizerModule {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly badgeCount?: () => number;
  init(container: HTMLElement): void;
  destroy?(): void;
}

export type EventCallback<T = any> = (data: T) => void;
