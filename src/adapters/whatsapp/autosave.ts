import type { Logger } from "../../core/contracts.js";
import type { Directory } from "./directory.js";
import { describeError } from "./protocol.js";

export interface DirectorySaver {
  /** Notifies listeners immediately and coalesces the file write into the next event-loop turn. */
  schedule(): void;
  /** Drops a pending write; used when the stored session is being removed. */
  cancel(): void;
  /** Writes any pending change and waits for every queued write. */
  flush(): Promise<void>;
}

export function createDirectorySaver(directory: Directory, logger: Logger, onUpdate: (() => void) | undefined): DirectorySaver {
  let scheduled: NodeJS.Immediate | null = null;
  return {
    schedule(): void {
      onUpdate?.();
      if (scheduled) return;
      scheduled = setImmediate(() => {
        scheduled = null;
        void directory.save().catch(error => logger(`Could not save WhatsApp contacts/chats: ${describeError(error)}`));
      });
    },
    cancel(): void {
      if (scheduled) { clearImmediate(scheduled); scheduled = null; }
    },
    async flush(): Promise<void> {
      if (scheduled) { clearImmediate(scheduled); scheduled = null; await directory.save(); }
      await directory.idle();
    },
  };
}
