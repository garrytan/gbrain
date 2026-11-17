**On PGLite, a managed `gbrain sync` that holds or skips many pages in a row now stops promptly on SIGTERM and keeps its timers running, instead of going silent for tens of seconds.**

### Fixed
- PGLite runs Postgres inside the gbrain process and answers queries without ever handing control back to the event loop, so a managed pass that settled pages without waiting on a write (pages held for file drift, for example) ran for up to 34 seconds at a time with no timer, progress watchdog or signal handler able to run. A SIGTERM then took about 18 seconds to reach its handler. Each step of a PGLite managed pass now lets the event loop take a turn first. Postgres syncs are unchanged (GST-2914).
