// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { listTasks } from "../src/api/client";

// Шаг 7b.1.2 — проброс AbortSignal до fetch.
//
// Учебный момент: тест модуля мокает весь `api/client`, поэтому снятие
// `signal` в client.ts он не поймает (mock обходит настоящий fetch).
// Здесь замокан сам fetch: abort обязан отклонить висящий промис.
// Regression proof: убери `signal` из client.ts — этот тест краснеет.
describe("api/client: проброс AbortSignal в fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abort отклоняет висящий listTasks через AbortError", async () => {
    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        seenSignal = (init?.signal as AbortSignal | undefined) ?? null;
        return new Promise((_resolve, reject) => {
          seenSignal?.addEventListener("abort", () => {
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          });
        });
      }),
    );

    const controller = new AbortController();
    const pending = listTasks(undefined, controller.signal);

    // Сигнал уже в fetch до abort — падает сразу при откате проброса
    expect(seenSignal).not.toBeNull();

    controller.abort();

    let error: unknown;
    try {
      await pending;
    } catch (err) {
      error = err;
    }

    expect(seenSignal?.aborted).toBe(true);
    expect((error as DOMException | undefined)?.name).toBe("AbortError");
  });
});
