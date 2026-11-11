import type { Runtime } from './bootstrap.js';
import type { ServerSettings } from './infrastructure/config.js';
import { startHttpServer } from './interfaces/http/server.js';

export interface ServeOptions {
  runtime: Runtime;
  settings: ServerSettings;
  /** Resolves when the process was asked to stop; may already be resolved. */
  stopped: Promise<void>;
  output(text: string): void;
}

/**
 * Runs the owner dashboard until `stopped` resolves, then stops serving before closing the runtime.
 * A failed restore (for example an expired ChatGPT login) leaves the dashboard up and forwarding
 * disarmed so the owner can fix the browser and resume; only HTTP startup failures end the run.
 */
export async function serveUntilStopped({ runtime, settings, stopped, output }: ServeOptions): Promise<void> {
  const { application } = runtime;
  let stopping = false;
  void stopped.then(() => { stopping = true; });
  let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    server = await startHttpServer({ application, settings });
    output(`wabgpt dashboard listening on ${server.url}\nSign in with the owner token from "wabgpt token".\n`);
    if (!stopping) {
      const restored = application.restore().catch(error => {
        application.log(`Saved forwarding could not resume: ${error instanceof Error ? error.message : String(error)} The dashboard is still running; fix the browser, then use Resume.`);
      });
      await Promise.race([restored, stopped]);
    }
    await stopped;
  } finally {
    try { await server?.close(); }
    finally { await runtime.close(); }
  }
}
