export type LogSeverity = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

export interface LogEntry {
  /** Monotonic id within this app session. */
  id: number;
  /** Epoch milliseconds. */
  ts: number;
  severity: LogSeverity;
  /** `node` (obsidian-core process), `node-stderr`, or `app`. */
  source: 'node' | 'node-stderr' | 'app';
  component: string;
  message: string;
  /** Structured fields from the node's JSON log line, already redacted. */
  fields?: Record<string, unknown>;
}
