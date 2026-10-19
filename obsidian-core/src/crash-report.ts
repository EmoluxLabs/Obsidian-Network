/**
 * What an operator sees when the node process dies from an error nobody handled.
 *
 * Node.js ends the process on an uncaught exception or an unhandled promise rejection and prints a stack to stderr, with
 * exit code 1 — the same code as every ordinary startup failure. A service that "keeps stopping" then shows nothing that
 * says WHY or WHICH kind of stop it was. This installs two handlers that write ONE structured line (message, the top of
 * the stack, uptime, memory) and exit with code {@link EXIT_UNHANDLED} (70, "internal software error"), so a restart loop
 * can be told from a configuration error at a glance (`systemctl status`, `journalctl -u obsidian-node@mainnet`).
 *
 * The node still stops: after an error nobody planned for, the in-memory state cannot be trusted, and carrying on is how a
 * node ends up signing or serving something wrong. Background peer-management tasks are guarded where they run, so that
 * a networking hiccup never gets this far. Nothing here prints a key, a passphrase or an environment value.
 */

/** Exit status of a process that ended because of an unhandled error (sysexits.h EX_SOFTWARE). */
export const EXIT_UNHANDLED = 70;

export interface CrashReportOptions {
  write?: (line: string) => void;
  exit?: (code: number) => void;
  now?: () => number;
  uptime?: () => number;
  memory?: () => { rss: number; heapUsed: number };
  /** Where to listen; defaults to the real `process`. Tests pass an EventEmitter. */
  target?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/** The single line written when the process dies. Pure: it reads nothing from the environment. */
export function describeCrash(
  kind: 'uncaughtException' | 'unhandledRejection',
  error: unknown,
  facts: { at: number; uptimeSeconds: number; rssMb: number; heapMb: number },
): string {
  const failure = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'a non-Error value was thrown');
  return JSON.stringify({
    time: new Date(facts.at).toISOString(),
    level: 'fatal',
    message: kind === 'unhandledRejection' ? 'unhandled promise rejection: the node is stopping' : 'uncaught exception: the node is stopping',
    kind,
    error: failure.message.slice(0, 400),
    code: typeof (failure as { code?: unknown }).code === 'string' ? String((failure as { code?: unknown }).code) : undefined,
    stack: (failure.stack ?? '').split('\n').slice(0, 10).join(' | ').slice(0, 1500),
    uptimeSeconds: Math.round(facts.uptimeSeconds),
    rssMb: facts.rssMb,
    heapMb: facts.heapMb,
    exitCode: EXIT_UNHANDLED,
  });
}

/** Install the handlers. Returns a function that removes them (for tests). */
export function installCrashReporting(options: CrashReportOptions = {}): () => void {
  const write = options.write ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? (() => Date.now());
  const uptime = options.uptime ?? (() => process.uptime());
  const memory = options.memory ?? (() => process.memoryUsage());
  const target = options.target ?? process;
  let reporting = false;
  const report = (kind: 'uncaughtException' | 'unhandledRejection') => (error: unknown) => {
    // An error while reporting an error must not loop.
    if (reporting) return;
    reporting = true;
    try {
      const usage = memory();
      write(describeCrash(kind, error, { at: now(), uptimeSeconds: uptime(), rssMb: Math.round(usage.rss / 1_048_576), heapMb: Math.round(usage.heapUsed / 1_048_576) }));
    } catch {
      /* nothing left to do but exit */
    }
    exit(EXIT_UNHANDLED);
  };
  const onException = report('uncaughtException');
  const onRejection = report('unhandledRejection');
  target.on('uncaughtException', onException);
  target.on('unhandledRejection', onRejection);
  return () => {
    target.off('uncaughtException', onException);
    target.off('unhandledRejection', onRejection);
  };
}
