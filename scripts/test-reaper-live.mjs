#!/usr/bin/env node
/** Public live cleanup entry point for the private Rex registry backstop. */
// Preserve this entry point for callers. The replacement checks bootstrap
// ownership separately and kills only explicit private registered fixtures.
await import('./test-rex-reaper-live.mjs');
