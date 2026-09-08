/**
 * core/events/index.ts
 *
 * The event bus surface. Modules import { eventBus } here; tests may build
 * isolated buses with createEventBus().
 */
export { createEventBus, eventBus } from './bus';
export type { EventBus } from './bus';