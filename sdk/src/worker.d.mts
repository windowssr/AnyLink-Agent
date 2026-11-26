import type { AnyLinkClient, AnyLinkSocket, LinkTask } from './client.d.mts';

export class TaskFailure extends Error {
  readonly code: string;
  readonly taskFailure: true;
  readonly learnBoundary: boolean;
  constructor(code: string, message: string, options?: { learnBoundary?: boolean });
}

export class TaskDeclined extends Error {
  readonly code: string;
  readonly taskDeclined: true;
  constructor(code: string, message: string);
}

export interface JournalStore {
  bind(server: string, deviceId: string, agentId: string | null): void;
  markStarted(taskId: string): boolean;
  markFinished(taskId: string, result: unknown): void;
  markReported(taskId: string): void;
  unfinishedResults(): Array<{ task_id: string; result: any }>;
  close(): void;
}

export class FileJournal implements JournalStore {
  constructor(journalPath: string);
  bind(server: string, deviceId: string, agentId: string | null): void;
  markStarted(taskId: string): boolean;
  markFinished(taskId: string, result: unknown): void;
  markReported(taskId: string): void;
  unfinishedResults(): Array<{ task_id: string; result: any }>;
  close(): void;
}

export interface HandlerContext {
  task: LinkTask;
  signal: AbortSignal;
  reportProgress: (progress: { stage?: string; message?: string; percent?: number; data?: Record<string, unknown> }) => Promise<void>;
}

export interface TaskHandler {
  description?: string;
  execute(input: Record<string, unknown>, context: HandlerContext): Promise<Record<string, unknown>>;
}

export class AnyLinkWorker {
  constructor(options: {
    client: AnyLinkClient;
    handlers?: Record<string, TaskHandler>;
    onInvoke?: (task: LinkTask, context: { signal: AbortSignal; reportProgress: HandlerContext['reportProgress'] }) => Promise<Record<string, unknown> | string>;
    journalPath?: string;
    journal?: JournalStore;
  });
  advertise(options?: { signal?: AbortSignal; idempotencyKey?: string }): Promise<{ capabilities: any[] }>;
  runNext(options?: { signal?: AbortSignal; taskId?: string; socket?: AnyLinkSocket }): Promise<{ task: LinkTask; replayed: boolean; execution_unknown: boolean } | null>;
  recoverResults(): Promise<LinkTask[]>;
  run(options?: { signal?: AbortSignal; pollIntervalMs?: number; useWebSocket?: boolean }): Promise<void>;
  close(): void;
}
