// Minimal UI API client for the spike (fetch only; the real kernel will use the generated client).

export interface ApiOptions
{
   baseUrl: string;
   token?: string;
}

export class ApiError extends Error
{
   constructor(public readonly status: number, public readonly body: unknown)
   {
      super(`HTTP ${status}: ${typeof body === "object" && body && "message" in body ? String((body as { message: unknown }).message) : JSON.stringify(body)}`);
   }
}

export class UiApi
{
   token: string | undefined;

   constructor(protected readonly baseUrl: string, token?: string)
   {
      this.token = token;
   }

   /** Spike finding: on this MOCK-auth sample server a bearer session UUID cannot continue an async
    *  process step ("Permission denied for process state"), while the same UUID as a cookie can. The
    *  spike therefore sends the session as a cookie; the real kernel will prefer bearer and fall back. */
   authMode: "cookie" | "bearer" = "cookie";

   protected headers(extra: Record<string, string> = {}): Record<string, string>
   {
      const h: Record<string, string> = { "X-QQQ-Client": "tui/qqq-spike 0.0.0", ...extra };
      if (this.token)
      {
         if (this.authMode === "bearer")
         {
            h["Authorization"] = `Bearer ${this.token}`;
         }
         else
         {
            h["Cookie"] = `sessionUUID=${this.token}`;
         }
      }
      return h;
   }

   async get<T>(path: string): Promise<T>
   {
      const res = await fetch(this.baseUrl + path, { headers: this.headers() });
      return this.unwrap<T>(res);
   }

   /** Process init/step take multipart/form-data; a url-encoded `values` JSON is silently ignored. */
   async postForm<T>(path: string, form: Record<string, string>): Promise<T>
   {
      const body = new FormData();
      for (const [k, v] of Object.entries(form))
      {
         body.append(k, v);
      }
      const res = await fetch(this.baseUrl + path, { method: "POST", headers: this.headers(), body });
      return this.unwrap<T>(res);
   }

   private async unwrap<T>(res: Response): Promise<T>
   {
      const text = await res.text();
      let parsed: unknown = text;
      try
      {
         parsed = text ? JSON.parse(text) : {};
      }
      catch
      {
         // leave as text
      }
      if (!res.ok)
      {
         throw new ApiError(res.status, parsed);
      }
      return parsed as T;
   }

   /** MOCK / FULLY_ANONYMOUS / TABLE_BASED: create a session and use its UUID as the bearer token. */
   async manageSession(): Promise<string>
   {
      const res = await fetch(this.baseUrl + "/manageSession", { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: "{}" });
      if (!res.ok)
      {
         throw new ApiError(res.status, await res.text());
      }
      const cookie = res.headers.get("set-cookie") ?? "";
      const match = /sessionUUID=([^;]+)/.exec(cookie);
      if (!match)
      {
         throw new Error("manageSession returned no sessionUUID cookie");
      }
      this.token = match[1]!;
      return this.token;
   }
}

export interface VersionResponse
{
   apiVersion: string;
   features: string[];
}

export interface AuthMetaData
{
   type: string;
   name: string;
}

export interface ProcessMetaData
{
   name: string;
   label: string;
   frontendSteps?: { name: string; label: string; components: { type: string; values?: Record<string, unknown> }[]; formFields?: { name: string; label: string; type: string; isRequired?: boolean }[]; viewFields?: { name: string; label: string }[] }[];
}

export type ProcessStepResponse =
   | { type: "COMPLETE"; processUUID: string; nextStep?: string; values?: Record<string, unknown> }
   | { type: "JOB_STARTED"; processUUID: string; jobUUID: string }
   | { type: "RUNNING"; processUUID: string; message?: string; current?: number; total?: number; progress?: unknown; logTail?: unknown }
   | { type: "ERROR"; processUUID: string; error?: string; userFacingError?: string };

// ---- shell additions: metadata, tables, records, realtime ----

export interface AppTreeNode
{
   type: "APP" | "TABLE" | "PROCESS" | "REPORT" | "WIDGET" | string;
   name: string;
   label: string;
   icon?: unknown;
   children?: AppTreeNode[];
}

export interface MetaDataResponse
{
   appTree: AppTreeNode[];
   tables: Record<string, { name: string; label: string; isHidden?: boolean }>;
   processes: Record<string, { name: string; label: string; isHidden?: boolean; tableName?: string }>;
   branding?: { appName?: string };
}

export interface FieldMetaData
{
   name: string;
   label: string;
   type: string;
   isRequired?: boolean;
   isEditable?: boolean;
   displayFormat?: string;
   possibleValueSourceName?: string | null;
}

export interface TableMetaData
{
   name: string;
   label: string;
   primaryKeyField: string;
   fields: Record<string, FieldMetaData>;
   sections: { name: string; label: string; tier: string; fieldNames?: string[] }[];
   deletePermission?: boolean;
   editPermission?: boolean;
   insertPermission?: boolean;
}

export interface QueryFilter
{
   criteria: { fieldName: string; operator: string; values: unknown[] }[];
   orderBys?: { fieldName: string; isAscending: boolean }[];
   booleanOperator?: "AND" | "OR";
   skip?: number;
   limit?: number;
}

export interface QRecord
{
   tableName: string;
   recordLabel?: string;
   values: Record<string, unknown>;
   displayValues: Record<string, string>;
}

export type RealtimeState = "connecting" | "connected" | "reconnecting" | "closed";

export class ShellApi extends UiApi
{
   metaData(): Promise<MetaDataResponse>
   {
      return this.get<MetaDataResponse>("/metaData");
   }

   tableMeta(table: string): Promise<TableMetaData>
   {
      return this.get<TableMetaData>(`/metaData/table/${encodeURIComponent(table)}`);
   }

   async postJson<T>(path: string, body: unknown): Promise<T>
   {
      const res = await fetch(this.baseUrl + path, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
      return this.unwrapPublic<T>(res);
   }

   async query(table: string, filter: QueryFilter): Promise<QRecord[]>
   {
      const r = await this.postJson<{ records: QRecord[] }>(`/table/${encodeURIComponent(table)}/query`, { filter });
      return r.records ?? [];
   }

   async count(table: string, filter: QueryFilter): Promise<number>
   {
      const r = await this.postJson<{ count: number }>(`/table/${encodeURIComponent(table)}/count`, { filter: { ...filter, skip: undefined, limit: undefined, orderBys: undefined } });
      return r.count ?? 0;
   }

   /** Tolerates both a bare record and a `{ record }` wrapper, and a missing displayValues map. */
   async getRecord(table: string, pk: string | number): Promise<QRecord>
   {
      const raw = await this.get<QRecord | { record: QRecord }>(`/table/${encodeURIComponent(table)}/${encodeURIComponent(String(pk))}`);
      const rec = (raw as { record?: QRecord }).record ?? (raw as QRecord);
      return { tableName: rec.tableName ?? table, recordLabel: rec.recordLabel, values: rec.values ?? {}, displayValues: rec.displayValues ?? {} };
   }

   async deleteRecord(table: string, pk: string | number): Promise<void>
   {
      const res = await fetch(`${this.baseUrl}/table/${encodeURIComponent(table)}/${encodeURIComponent(String(pk))}`, { method: "DELETE", headers: this.headers() });
      await this.unwrapPublic<unknown>(res);
   }

   /** Round-trip time of GET /version in milliseconds. */
   async ping(): Promise<number>
   {
      const t = performance.now();
      await this.get<unknown>("/version");
      return performance.now() - t;
   }

   /** Server-sent events: calls onState on connection changes and onEvent per event; returns a stop function. */
   realtime(onState: (s: RealtimeState) => void, onEvent: (name: string, data: string) => void): () => void
   {
      let stopped = false;
      const controller = new AbortController();
      const connect = async (attempt: number) =>
      {
         if (stopped)
         {
            return;
         }
         onState(attempt === 0 ? "connecting" : "reconnecting");
         try
         {
            const res = await fetch(this.baseUrl + "/realtime/stream", { headers: this.headers({ Accept: "text/event-stream" }), signal: controller.signal });
            if (!res.ok || !res.body)
            {
               throw new Error(`HTTP ${res.status}`);
            }
            onState("connected");
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;)
            {
               const { value, done } = await reader.read();
               if (done)
               {
                  break;
               }
               buffer += decoder.decode(value, { stream: true });
               let idx;
               while ((idx = buffer.indexOf("\n\n")) >= 0)
               {
                  const chunk = buffer.slice(0, idx);
                  buffer = buffer.slice(idx + 2);
                  let name = "message";
                  const data: string[] = [];
                  for (const line of chunk.split("\n"))
                  {
                     if (line.startsWith("event:")) name = line.slice(6).trim();
                     else if (line.startsWith("data:")) data.push(line.slice(5).trim());
                  }
                  onEvent(name, data.join("\n"));
               }
            }
         }
         catch
         {
            // fall through to reconnect
         }
         if (!stopped)
         {
            onState("reconnecting");
            setTimeout(() => void connect(attempt + 1), Math.min(10_000, 1000 * (attempt + 1)));
         }
      };
      void connect(0);
      return () =>
      {
         stopped = true;
         controller.abort();
         onState("closed");
      };
   }

   private async unwrapPublic<T>(res: Response): Promise<T>
   {
      const text = await res.text();
      let parsed: unknown = text;
      try
      {
         parsed = text ? JSON.parse(text) : {};
      }
      catch
      {
         // text
      }
      if (!res.ok)
      {
         throw new ApiError(res.status, parsed);
      }
      return parsed as T;
   }
}
