/**
 * Typed synchronous event bus.
 *
 * - Handlers are isolated: an exception in one handler never breaks the agent
 *   loop or other subscribers (a broken renderer cannot kill the engine).
 * - `on` gives typed per-event subscriptions; `onAny` receives every event.
 */

export type Unsubscribe = () => void;

function safeInvoke(handler: (event: unknown) => void, event: unknown): void {
  try {
    handler(event);
  } catch (error) {
    // A renderer must never be able to break the engine loop.
    console.error("[harness] event handler failed:", error);
  }
}

export class EventBus<T extends { type: string }> {
  private readonly handlers = new Map<T["type"], Set<(event: T) => void>>();
  private readonly anyHandlers = new Set<(event: T) => void>();

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<K extends T["type"]>(type: K, handler: (event: Extract<T, { type: K }>) => void): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<(event: T) => void>();
    set.add(handler as (event: T) => void);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as (event: T) => void);
    };
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onAny(handler: (event: T) => void): Unsubscribe {
    const typed = handler as (event: T) => void;
    this.anyHandlers.add(typed);
    return () => {
      this.anyHandlers.delete(typed);
    };
  }

  /** Dispatch synchronously to all subscribers. */
  emit(event: T): void {
    const typed = this.handlers.get(event.type);
    if (typed !== undefined) {
      for (const handler of typed) {
        safeInvoke(handler as (event: unknown) => void, event);
      }
    }
    for (const handler of this.anyHandlers) {
      safeInvoke(handler as (event: unknown) => void, event);
    }
  }

  /** Remove all subscriptions. */
  clear(): void {
    this.handlers.clear();
    this.anyHandlers.clear();
  }
}
