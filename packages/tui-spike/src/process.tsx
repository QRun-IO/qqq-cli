// Runs a real UI API process (default: the sample's Sleep Interactive) with an async job and progress.

import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { ApiError, UiApi, type AuthMetaData, type ProcessMetaData, type ProcessStepResponse, type VersionResponse } from "./api";

const BASE = (process.env.QQQ_SERVER ?? "http://localhost:8077") + "/qqq/v1";
const PROCESS = process.env.QQQ_PROCESS ?? "sleepInteractive";

const C = { dim: "#66737f", acc: "#7cc2e8", ok: "#8bd49b", err: "#ff9088", key: "#ffd98a", bar: "#8bd49b", barBg: "#2a333f", focusBg: "#1f3646" };

interface Log
{
   at: string;
   text: string;
   kind: "info" | "ok" | "err";
}

export function ProcessScreen({ width, active }: { width: number; active: boolean })
{
   const api = useRef(new UiApi(BASE));
   const [phase, setPhase] = useState<"connecting" | "ready" | "running" | "done" | "error">("connecting");
   const [meta, setMeta] = useState<ProcessMetaData | null>(null);
   const [server, setServer] = useState("");
   const [stepIndex, setStepIndex] = useState(0);
   const [sleepMillis, setSleepMillis] = useState("4000");
   const [progress, setProgress] = useState<{ message?: string; current?: number; total?: number } | null>(null);
   const [result, setResult] = useState<Record<string, unknown> | null>(null);
   const [logs, setLogs] = useState<Log[]>([]);
   const [elapsed, setElapsed] = useState(0);
   const [polls, setPolls] = useState(0);
   const processUUID = useRef<string | null>(null);
   const startedAt = useRef(0);

   function log(text: string, kind: Log["kind"] = "info")
   {
      setLogs((l) => [...l.slice(-7), { at: new Date().toISOString().slice(11, 19), text, kind }]);
   }

   useEffect(() =>
   {
      let cancelled = false;
      (async () =>
      {
         try
         {
            const version = await api.current.get<VersionResponse>("/version");
            const auth = await api.current.get<AuthMetaData>("/metaData/authentication");
            if (auth.type !== "MOCK" && auth.type !== "FULLY_ANONYMOUS")
            {
               throw new Error(`spike only handles MOCK/FULLY_ANONYMOUS auth, server says ${auth.type}`);
            }
            await api.current.manageSession();
            const m = await api.current.get<ProcessMetaData>(`/metaData/process/${PROCESS}`);
            if (cancelled)
            {
               return;
            }
            setServer(`${BASE} · UI API ${version.apiVersion} · auth ${auth.type} · session as ${api.current.authMode}`);
            setMeta(m);
            setPhase("ready");
            log(`connected, session created, process "${m.label}" has ${m.frontendSteps.length} steps`, "ok");
         }
         catch (e)
         {
            if (!cancelled)
            {
               setPhase("error");
               log(e instanceof Error ? e.message : String(e), "err");
            }
         }
      })();
      return () =>
      {
         cancelled = true;
      };
   }, []);

   async function run()
   {
      if (!meta || phase === "running")
      {
         return;
      }
      setPhase("running");
      setResult(null);
      setProgress(null);
      setPolls(0);
      startedAt.current = performance.now();
      try
      {
         const init = await api.current.postForm<ProcessStepResponse>(`/processes/${meta.name}/init`, { values: "{}" });
         if (init.type !== "COMPLETE")
         {
            throw new Error(`unexpected init response ${init.type}`);
         }
         processUUID.current = init.processUUID;
         log(`init → processUUID ${init.processUUID.slice(0, 8)}… next step ${init.nextStep}`);
         setStepIndex(1);
         const step0 = meta.frontendSteps[0]!;
         let response = await api.current.postForm<ProcessStepResponse>(`/processes/${meta.name}/${init.processUUID}/step/${step0.name}`, {
            values: JSON.stringify({ sleepMillis: Number(sleepMillis) || 0 }),
            stepTimeoutMillis: "0",
         });
         if (response.type === "JOB_STARTED")
         {
            log(`step ${step0.name} → job ${response.jobUUID.slice(0, 8)}… (async)`);
            const jobUUID = response.jobUUID;
            while (response.type === "JOB_STARTED" || response.type === "RUNNING")
            {
               await new Promise((r) => setTimeout(r, 250));
               response = await api.current.get<ProcessStepResponse>(`/processes/${meta.name}/${init.processUUID}/status/${jobUUID}`);
               setPolls((n) => n + 1);
               setElapsed(performance.now() - startedAt.current);
               if (response.type === "RUNNING")
               {
                  setProgress({ message: response.message, current: response.current, total: response.total });
               }
            }
         }
         if (response.type === "ERROR")
         {
            throw new Error(String(response.userFacingError ?? response.error ?? "process error"));
         }
         if (response.type === "COMPLETE")
         {
            setElapsed(performance.now() - startedAt.current);
            setResult(response.values ?? {});
            setStepIndex(meta.frontendSteps.length);
            setPhase("done");
            log(`complete in ${((performance.now() - startedAt.current) / 1000).toFixed(2)} s · nextStep ${response.nextStep}`, "ok");
         }
      }
      catch (e)
      {
         setPhase("error");
         log(e instanceof ApiError ? `${e.message} (${JSON.stringify(e.body).slice(0, 120)})` : e instanceof Error ? e.message : String(e), "err");
      }
   }

   useKeyboard((key: KeyEvent) =>
   {
      if (!active)
      {
         return;
      }
      if (key.name === "return" && (phase === "ready" || phase === "done" || phase === "error") && meta)
      {
         void run();
      }
      else if (key.name === "r" && phase === "error")
      {
         setPhase(meta ? "ready" : "error");
      }
   });

   const barWidth = Math.max(10, Math.min(40, width - 30));
   const pct = progress && progress.total ? Math.min(1, (progress.current ?? 0) / progress.total) : null;
   const filled = pct === null ? 0 : Math.round(pct * barWidth);

   return (
      <box flexDirection="column" width={width}>
         <text fg={C.acc}>{meta ? `${meta.label} (${meta.name})` : `process ${PROCESS}`}</text>
         <text fg={C.dim}>{server || "connecting…"}</text>
         <box flexDirection="row" gap={2} marginTop={1}>
            <box flexDirection="column" width={22}>
               <text fg={C.dim}>Steps</text>
               {(meta?.frontendSteps ?? []).map((s, i) => (
                  <text key={s.name} fg={i < stepIndex ? C.ok : i === stepIndex ? C.acc : C.dim} bg={i === stepIndex ? C.focusBg : undefined}>
                     {`${i < stepIndex ? "[x]" : i === stepIndex ? "[▶]" : "[ ]"} ${i + 1} ${s.label}`.padEnd(22)}
                  </text>
               ))}
            </box>
            <box flexDirection="column" flexGrow={1}>
               <box flexDirection="row" gap={1}>
                  <text>sleepMillis</text>
                  <box width={12} backgroundColor={C.focusBg}>
                     <input focused={active && phase === "ready"} value={sleepMillis} onInput={setSleepMillis} />
                  </box>
                  <text fg={C.key}>{phase === "ready" ? "Enter runs the process" : phase === "running" ? "running…" : phase === "done" ? "done · Enter runs again" : phase === "error" ? "error · r to reset" : ""}</text>
               </box>
               {phase === "running" && (
                  <box flexDirection="column" marginTop={1}>
                     <text>
                        <span fg={C.bar}>{"█".repeat(filled)}</span><span fg={C.barBg}>{"░".repeat(barWidth - filled)}</span>
                        {pct === null ? "  waiting for first status" : `  ${Math.round(pct * 100)}%  (${progress?.current ?? 0} of ${progress?.total ?? 0})`}
                     </text>
                     <text fg={C.dim}>{`${progress?.message ?? "…"} · ${(elapsed / 1000).toFixed(1)} s · ${polls} status polls at 250 ms`}</text>
                  </box>
               )}
               {result && (
                  <box flexDirection="column" marginTop={1}>
                     <text fg={C.ok}>{`result after ${(elapsed / 1000).toFixed(2)} s:`}</text>
                     {Object.entries(result).map(([k, v]) => <text key={k}>{`  ${k}: ${String(v)}`}</text>)}
                  </box>
               )}
            </box>
         </box>
         <box flexDirection="column" marginTop={1}>
            {logs.map((l, i) => <text key={i} fg={l.kind === "ok" ? C.ok : l.kind === "err" ? C.err : C.dim}>{`${l.at}  ${l.text}`}</text>)}
         </box>
      </box>
   );
}
