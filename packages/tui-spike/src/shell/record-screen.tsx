import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import type { QRecord, ShellApi, TableMetaData } from "../api";
import { pad } from "../grid";
import { T } from "./theme";

export function RecordScreen({ api, table, pk, width, height, active, refreshToken, onMessage }: { api: ShellApi; table: string; pk: string | number; width: number; height: number; active: boolean; refreshToken: number; onMessage: (t: string, k?: "info" | "err") => void })
{
   const [meta, setMeta] = useState<TableMetaData | null>(null);
   const [rec, setRec] = useState<QRecord | null>(null);
   const [scroll, setScroll] = useState(0);
   useEffect(() =>
   {
      Promise.all([api.tableMeta(table), api.getRecord(table, pk)]).then(([m, r]) => { setMeta(m); setRec(r); }).catch((e) => onMessage(String(e), "err"));
   }, [table, pk, refreshToken]);

   const inner = width - 2;
   const lines: { text: string; kind: "h" | "f" | "blank" }[] = [];
   if (meta && rec)
   {
      lines.push({ text: ` ${rec.recordLabel ?? pk}`, kind: "h" });
      const labelWidth = Math.min(24, Math.max(10, ...Object.values(meta.fields).map((f) => f.label.length + 2)));
      const twoCol = inner >= 100;
      const colWidth = twoCol ? Math.floor(inner / 2) : inner;
      for (const s of meta.sections)
      {
         const fields = (s.fieldNames ?? []).filter((f) => meta.fields[f]);
         if (fields.length === 0) continue;
         lines.push({ text: "", kind: "blank" });
         lines.push({ text: ` ${s.label} (${s.tier}) ${"─".repeat(Math.max(0, inner - s.label.length - 8))}`, kind: "h" });
         const cells = fields.map((f) => pad(`  ${pad(meta.fields[f]!.label, labelWidth)} ${(rec.displayValues ?? {})[f] ?? String((rec.values ?? {})[f] ?? "")}`, colWidth));
         for (let i = 0; i < cells.length; i += twoCol ? 2 : 1)
         {
            lines.push({ text: twoCol ? cells[i]! + (cells[i + 1] ?? "") : cells[i]!, kind: "f" });
         }
      }
   }
   const bodyRows = height;
   const maxScroll = Math.max(0, lines.length - bodyRows);
   useKeyboard((key: KeyEvent) =>
   {
      if (!active) return;
      if (key.name === "down") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.name === "up") setScroll((s) => Math.max(0, s - 1));
      else if (key.name === "pagedown") setScroll((s) => Math.min(maxScroll, s + bodyRows));
      else if (key.name === "pageup") setScroll((s) => Math.max(0, s - bodyRows));
      else if (key.name === "home") setScroll(0);
      else if (key.name === "end") setScroll(maxScroll);
   });
   const shown = lines.slice(scroll, scroll + bodyRows);
   while (shown.length < bodyRows) shown.push({ text: "", kind: "blank" });
   return (
      <box flexDirection="column" width={width} height={height + 2} border borderColor={active ? T.focusBorder : T.border} title={` ${meta?.label ?? table} › ${pk} `}>
         {shown.map((l, i) => <text key={i} fg={l.kind === "h" ? T.acc : T.fg}>{pad(l.text, inner)}</text>)}
      </box>
   );
}
