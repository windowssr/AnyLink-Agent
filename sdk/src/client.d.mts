export type AnyLinkPlatform = 'macos' | 'android' | 'linux' | 'windows' | 'ios' | 'web' | 'other';
export type MemoryScope = 'global' | 'device' | 'agent';
export type MemoryKind = 'fact' | 'preference' | 'boundary' | 'episode';
export type TaskState = 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'unknown' | 'expired';

export class AnyLinkError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly idempotencyKey?: string;
  readonly submissionUnknown: boolean;
  constructor(message: string, options?: { code?: string; status?: number; requestId?: string; idempotencyKey?: string; submissionUnknown?: boolean; cause?: unknown });
}

export interface RequestOptions { idempotencyKey?: string; signal?: AbortSignal; headers?: Record<string, string>; }
export interface ChatOptions extends RequestOptions { autoMemory?: boolean; }
export interface ClientOptions { baseUrl: string; token: string; fetch?: typeof fetch; WebSocketImpl?: typeof WebSocket; timeoutMs?: number; }
export interface ConnectOptions {
  baseUrl: string; joinKey: string; installId: string;
  device: { name: string; platform?: AnyLinkPlatform };
  agent: { key: string; name: string; kind?: string; summary?: string };
  fetch?: typeof fetch; timeoutMs?: number;
}
export interface ConnectResult { device_id: string; agent_id: string; credential_id: string; token: string; protocol: { name: string; version: string }; }
export interface Capability { name: string; description: string; }
export type TaskTarget = { agent_id: string } | { device_id: string } | { device_name: string } | { agent_key: string };
export interface TaskResult {
  state: 'succeeded' | 'failed' | 'declined' | 'cancelled' | 'unknown';
  output?: Record<string, unknown>;
  error?: { code: string; message: string; learn_boundary?: boolean };
}
export interface LinkTask {
  id: string; source_device_id: string; source_agent_id: string; target_agent_id: string | null; claimed_by_agent_id: string | null;
  target_device_id: string | null; capability: string; instruction: string | null; input: Record<string, unknown>;
  state: TaskState; progress: Record<string, unknown> | null; result: TaskResult | null;
  lease_seconds: number; lease_expires_at: string | null; heartbeat_at: string | null;
  created_at: string; expires_at: string; started_at: string | null; finished_at: string | null;
}

export class AnyLinkSocket extends EventTarget {
  readonly connected: boolean;
  constructor(options: { wsUrl: string; token: string; WebSocketImpl?: typeof WebSocket });
  connect(options?: { timeoutMs?: number; autoReconnect?: boolean }): Promise<this>;
  on(type: string, listener: (frame: any) => void): () => void;
  sendRpc(frame: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<any>;
  claimTask(options?: { taskId?: string; idempotencyKey?: string; timeoutMs?: number }): Promise<{ task: LinkTask | null }>;
  heartbeatTask(taskId: string, options?: { extendSeconds?: number; timeoutMs?: number }): Promise<any>;
  reportProgress(taskId: string, progress: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<any>;
  completeTask(taskId: string, result: TaskResult, options?: { idempotencyKey?: string; timeoutMs?: number }): Promise<{ task: LinkTask }>;
  cancelTask(taskId: string, options?: { idempotencyKey?: string; timeoutMs?: number }): Promise<{ task: LinkTask }>;
  close(): void;
}

export class AnyLinkClient {
  readonly baseUrl: string;
  constructor(options: ClientOptions);
  static connect(options: ConnectOptions): Promise<ConnectResult>;
  wsUrl(): string;
  connectWebSocket(options?: { timeoutMs?: number; autoReconnect?: boolean; WebSocketImpl?: typeof WebSocket }): Promise<AnyLinkSocket>;
  protocol(options?: RequestOptions): Promise<Record<string, unknown>>;
  directory(options?: RequestOptions): Promise<{ items: any[] }>;
  peers(options?: RequestOptions): Promise<{ items: any[] }>;
  persona(options?: RequestOptions): Promise<{ name: string; sha256: string; content: string }>;
  identity(options?: RequestOptions): Promise<{ device: any; agent: any; scopes: string[]; protocol: { name: string; version: string } }>;
  updateProfile(profile: { name?: string; summary?: string; kind?: string }, options?: RequestOptions): Promise<any>;
  adoptInstallId(installId: string, options?: RequestOptions): Promise<{ device_id: string; install_id: string }>;

  assembleMemory(query?: { query?: string; max_memories?: number; max_episodes?: number; max_chars?: number; include_scopes?: MemoryScope[]; include_boundaries?: boolean; include_persona?: boolean }, options?: RequestOptions): Promise<{ device_id: string; agent_id: string; memories: any[]; boundaries: any[]; episodes: any[]; summary_text: string; persona?: any }>;
  ingestMemory(payload: { kind?: 'turn' | 'task_outcome' | 'observation'; session_key?: string; messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; name?: string }>; metadata?: Record<string, unknown>; consolidate_now?: boolean }, options?: RequestOptions): Promise<{ episode_id: string; status: string; summary?: string; actions?: unknown[] }>;
  episodes(query?: { limit?: number }, options?: RequestOptions): Promise<{ items: any[] }>;
  context(options?: RequestOptions): Promise<any>;
  searchMemories(query?: { q?: string; scope?: MemoryScope; kind?: MemoryKind; device_id?: string; limit?: number }, options?: RequestOptions): Promise<{ items: any[] }>;
  saveMemory(memory: { title: string; content: string; scope: MemoryScope; kind?: MemoryKind; tags?: string[]; importance?: number; applicable_device_id?: string | null; applicable_agent_id?: string | null }, options?: RequestOptions): Promise<any>;
  updateMemory(id: string, revision: number, patch: { title?: string; content?: string; kind?: MemoryKind; tags?: string[]; importance?: number }, options?: RequestOptions): Promise<any>;
  deleteMemory(id: string, revision: number, options?: RequestOptions): Promise<{ id: string; revision: number; deleted: true }>;

  models(options?: RequestOptions): Promise<{ object: 'list'; data: any[] }>;
  chatCompletions(input: Record<string, unknown>, options?: ChatOptions): Promise<any>;
  streamChatCompletions(input: Record<string, unknown>, options?: ChatOptions): AsyncGenerator<any, void, void>;
  speech(input: { text: string; summarize?: boolean; voice?: 'sweet-lively' | 'sweet-warm' | 'neutral-en'; style?: 'neutral' | 'persona'; system_prompt?: string }, options?: RequestOptions): Promise<{ spoken_text: string; voice: string; format: string; audio_base64: string }>;

  registerCapabilities(capabilities: Capability[], options?: RequestOptions): Promise<{ agent_id: string; device_id: string; capabilities: Capability[] }>;
  invoke(request: { target?: TaskTarget; instruction?: string; capability?: string; input?: Record<string, unknown>; ttlSeconds?: number; leaseSeconds?: number }, options?: RequestOptions): Promise<LinkTask>;
  createTask(task: { target?: TaskTarget; target_device_id?: string; instruction?: string; capability?: string; input?: Record<string, unknown>; ttl_seconds?: number; lease_seconds?: number }, options?: RequestOptions): Promise<LinkTask>;
  task(id: string, options?: RequestOptions): Promise<LinkTask>;
  listTasks(query?: { role?: 'source' | 'target'; state?: TaskState }, options?: RequestOptions): Promise<{ items: LinkTask[] }>;
  claimTask(options?: RequestOptions & { taskId?: string }): Promise<{ task: LinkTask | null }>;
  heartbeatTask(id: string, options?: RequestOptions & { extendSeconds?: number }): Promise<any>;
  reportProgress(id: string, progress: { stage?: string; message?: string; percent?: number; data?: Record<string, unknown> }, options?: RequestOptions): Promise<LinkTask>;
  completeTask(id: string, result: TaskResult, options?: RequestOptions): Promise<LinkTask>;
  cancelTask(id: string, options?: RequestOptions): Promise<LinkTask>;
  waitForTask(taskId: string, options?: { socket?: AnyLinkSocket; timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal; onProgress?: (progress: any) => void }): Promise<LinkTask>;
}
