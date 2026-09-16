// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { AppShell } from "../src/core/app-shell";
import { globalEvents } from "../src/core/event-bus";
import type { OrganizerModule } from "../src/core/types";

// Шаг 15.5: пульс бейджа — поведение, а не реализация.
// Проверяем наблюдаемый DOM: класс появляется только в момент смены цифры.
describe("AppShell: badge pulse on count change", () => {
  let container: HTMLElement;
  let count = 0;

  const stub: OrganizerModule = {
    id: "todos",
    title: "Задачи",
    icon: "✓",
    badgeCount: () => count,
    init: () => {},
  };

  const badge = (): HTMLElement | null =>
    container.querySelector("#badge-todos");

  beforeEach(() => {
    count = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    new AppShell(container).registerModule(stub);
  });

  it("скрытый бейдж без цифры не пульсирует", () => {
    expect(badge()?.textContent).toBe("");
    expect(badge()?.classList.contains("sidebar__badge--pulse")).toBe(false);
  });

  it("смена цифры вешает одноразовый пульс", () => {
    count = 3;
    globalEvents.emit("module:badge-updated");

    expect(badge()?.textContent).toBe("3");
    expect(badge()?.classList.contains("sidebar__badge--pulse")).toBe(true);
  });

  it("та же цифра повторно пульс не перезапускает", () => {
    count = 3;
    globalEvents.emit("module:badge-updated");
    badge()?.classList.remove("sidebar__badge--pulse");

    globalEvents.emit("module:badge-updated");

    expect(badge()?.classList.contains("sidebar__badge--pulse")).toBe(false);
  });
});
