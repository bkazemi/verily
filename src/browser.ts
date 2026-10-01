/** Browser-safe public entry point: no Node, provider, or database modules. */
export * from './core/index.js';

export { init, presentConnections, type Result } from './browser/index.js';
