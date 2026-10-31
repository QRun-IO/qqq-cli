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

   constructor(private readonly baseUrl: string, token?: string)
   {
      this.token = token;
   }

   /** Spike finding: on this MOCK-auth sample server a bearer session UUID cannot continue an async
    *  process step ("Permission denied for process state"), while the same UUID as a cookie can. The
    *  spike therefore sends the session as a cookie; the real kernel will prefer bearer and fall back. */
   authMode: "cookie" | "bearer" = "cookie";

   private headers(extra: Record<string, string> = {}): Record<string, string>
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
   frontendSteps: { name: string; label: string; components: { type: string; values?: Record<string, unknown> }[]; formFields?: { name: string; label: string; type: string; isRequired?: boolean }[]; viewFields?: { name: string; label: string }[] }[];
}

export type ProcessStepResponse =
   | { type: "COMPLETE"; processUUID: string; nextStep?: string; values?: Record<string, unknown> }
   | { type: "JOB_STARTED"; processUUID: string; jobUUID: string }
   | { type: "RUNNING"; processUUID: string; message?: string; current?: number; total?: number; progress?: unknown; logTail?: unknown }
   | { type: "ERROR"; processUUID: string; error?: string; userFacingError?: string };
