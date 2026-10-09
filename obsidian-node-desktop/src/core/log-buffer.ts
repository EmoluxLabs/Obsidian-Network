/**
 * In-memory ring buffer of recent log entries, with an optional redacted on-disk copy.
 *
 * Node output arrives as JSON lines (obsidian-core's Logger). Lines that are not JSON,
 * and everything on stderr, are kept as plain entries. Everything is redacted before it
 * is stored, so neither the screen, the file nor an exported bundle can contain a secret
 * that appeared in a log line.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry, LogSeverity } from '../shared/log-types.js';
import { redactText, redactValue } from './redact.js';

const LEVEL_MAP: Record<string, LogSeverity> = { error: 'ERROR', fatal: 'ERROR', warn: 'WARN', warning: 'WARN', info: 'INFO', debug: 'DEBUG', trace: 'DEBUG' };
const MAX_MESSAGE = 2000;
const FILE_LIMIT = 5 * 1024 * 1024;
const FILES_KEPT = 3;

export class LogBuffer {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private listeners = new Set<(entry: LogEntry) => void>();

  constructor(
    private readonly capacity = 2000,
    private filePath?: string,
  ) {}

  /** Point the on-disk copy at another file (the log follows the selected network). */
  setFile(path: string | undefined): void {
    this.filePath = path;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  app(severity: LogSeverity, message: string, component = 'app'): LogEntry {
    return this.add({ severity, source: 'app', component, message });
  }

  /** Parse and add one line of the node's stdout or stderr. */
  line(raw: string, stream: 'stdout' | 'stderr'): LogEntry | undefined {
    const text = raw.replace(/\r$/, '');
    if (text.trim().length === 0) return undefined;
    if (stream === 'stdout' && text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.message === 'string') {
          const { ts, level, component, message, ...fields } = parsed;
          return this.add({
            ts: typeof ts === 'string' ? Date.parse(ts) || Date.now() : Date.now(),
            severity: LEVEL_MAP[String(level).toLowerCase()] ?? 'INFO',
            source: 'node',
            component: typeof component === 'string' ? component : 'node',
            message: String(message),
            fields: Object.keys(fields).length > 0 ? (redactValue(fields) as Record<string, unknown>) : undefined,
          });
        }
      } catch {
        /* fall through to a plain entry */
      }
    }
    return this.add({ severity: stream === 'stderr' ? 'ERROR' : 'INFO', source: stream === 'stderr' ? 'node-stderr' : 'node', component: 'process', message: text });
  }

  private add(partial: Omit<LogEntry, 'id' | 'ts'> & { ts?: number }): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      ts: partial.ts ?? Date.now(),
      severity: partial.severity,
      source: partial.source,
      component: partial.component.slice(0, 64),
      message: redactText(partial.message).slice(0, MAX_MESSAGE),
      fields: partial.fields,
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    this.persist(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* a broken subscriber must not break logging */
      }
    }
    return entry;
  }

  recent(options: { limit?: number; minSeverity?: LogSeverity; sinceId?: number } = {}): LogEntry[] {
    const order: LogSeverity[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const min = options.minSeverity ? order.indexOf(options.minSeverity) : 0;
    const selected = this.entries.filter((e) => e.id > (options.sinceId ?? 0) && order.indexOf(e.severity) >= min);
    return selected.slice(-(options.limit ?? 500));
  }

  clear(): void {
    this.entries = [];
  }

  private persist(entry: LogEntry): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath) && statSync(this.filePath).size > FILE_LIMIT) this.rotate();
      appendFileSync(
        this.filePath,
        `${new Date(entry.ts).toISOString()} ${entry.severity} [${entry.component}] ${entry.message}${entry.fields ? ` ${JSON.stringify(entry.fields)}` : ''}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* disk logging is best effort; the in-memory buffer still has the entry */
    }
  }

  private rotate(): void {
    if (!this.filePath) return;
    for (let i = FILES_KEPT - 1; i >= 1; i -= 1) {
      const from = `${this.filePath}.${i}`;
      if (existsSync(from)) {
        if (i === FILES_KEPT - 1) unlinkSync(from);
        else renameSync(from, `${this.filePath}.${i + 1}`);
      }
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}
