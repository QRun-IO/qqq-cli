import { pad } from "../grid";
import { T } from "./theme";

export interface StatusInfo
{
   server: string;
   apiVersion: string;
   auth: string;
   sessionShort: string;
   pingMs: number | null;
   stream: string;
   lastEvent: string;
   jobs: string;
   clock: string;
}

export function StatusLine({ width, info }: { width: number; info: StatusInfo })
{
   const ping = info.pingMs === null ? "ping --" : `ping ${info.pingMs.toFixed(0)} ms`;
   const streamColor = info.stream === "connected" ? T.ok : info.stream === "reconnecting" ? T.warn : T.dim;
   const left = ` ${info.server} · ${info.auth} ${info.sessionShort} · UI API ${info.apiVersion} · ${ping} · `;
   const right = ` · jobs ${info.jobs} · ${info.lastEvent} · ${info.clock} `;
   const streamText = `stream ${info.stream}`;
   const fill = Math.max(0, width - left.length - streamText.length - right.length);
   return (
      <text bg={T.statusBg}>
         <span fg={T.dim}>{left}</span>
         <span fg={streamColor}>{streamText}</span>
         <span fg={T.dim}>{pad(right, right.length + fill)}</span>
      </text>
   );
}

export interface FKey
{
   n: number;
   label: string;
   enabled?: boolean;
}

export function FKeyBar({ width, keys }: { width: number; keys: FKey[] })
{
   const cell = Math.max(8, Math.floor(width / 10));
   return (
      <text>
         {keys.map((k) =>
         {
            const num = String(k.n).padStart(2);
            const label = pad(k.label, cell - 2);
            return (
               <span key={k.n}>
                  <span fg={T.keyNum}>{num}</span>
                  <span fg={k.enabled === false ? T.dim : T.keyLabelFg} bg={T.keyLabelBg}>{label}</span>
               </span>
            );
         })}
      </text>
   );
}
