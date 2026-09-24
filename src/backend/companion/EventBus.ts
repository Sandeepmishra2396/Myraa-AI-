/**
 * MYRAA — EventBus (Phase 6)
 *
 * Lightweight, decoupled pub/sub event bus for companion events.
 * Connects background monitors and schedulers with notification managers
 * and WebSocket streaming without circular dependencies.
 */

export type CompanionEventType =
  | "task:started"
  | "task:iteration"
  | "task:completed"
  | "task:failed"
  | "task:cancelled"
  | "monitor:build_changed"
  | "monitor:git_changed"
  | "monitor:deployment_changed"
  | "notification:created"
  | "notification:voice"
  | "preferences:updated";

export interface CompanionEvent<T = unknown> {
  type: CompanionEventType;
  timestamp: string;
  data: T;
}

export type EventHandler<T = any> = (event: CompanionEvent<T>) => void | Promise<void>;

export class EventBus {
  private _handlers = new Map<CompanionEventType, Set<EventHandler>>();

  /** Subscribe an event handler for a specific event type. */
  on<T = unknown>(type: CompanionEventType, handler: EventHandler<T>): () => void {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    const handlers = this._handlers.get(type)!;
    handlers.add(handler as EventHandler);

    // Unsubscribe helper
    return () => {
      handlers.delete(handler as EventHandler);
    };
  }

  /** Emit an event synchronously or asynchronously to all registered listeners. */
  emit<T = unknown>(type: CompanionEventType, data: T): void {
    const event: CompanionEvent<T> = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const handlers = this._handlers.get(type);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result && typeof (result as any).catch === "function") {
          (result as Promise<void>).catch((err) =>
            console.error(`[EventBus] Error in async handler for '${type}':`, err),
          );
        }
      } catch (err) {
        console.error(`[EventBus] Error executing handler for '${type}':`, err);
      }
    }
  }

  /** Clear all handlers (useful for clean test teardown). */
  clear(): void {
    this._handlers.clear();
  }
}

/** Global singleton event bus for MYRAA Companion. */
export const eventBus = new EventBus();
