// Server-paged-style grid: only the visible window is rendered, each row as one text line.

import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { formatCell, sortRows, type Column, type Row, type SortDirection } from "./data";
import { lastOf, record } from "./perf";

export interface GridProps
{
   rows: Row[];
   columns: Column[];
   width: number;
   height: number;
   active: boolean;
}

export const GRID_COLORS = {
   header: "#7cc2e8",
   dim: "#66737f",
   selectedBg: "#1f3646",
   selectedFg: "#ffffff",
   cursorColBg: "#2a4a60",
   text: "#d5dce5",
};

export function pad(text: string, width: number): string
{
   if (text.length === width)
   {
      return text;
   }
   if (text.length > width)
   {
      return width > 1 ? text.slice(0, width - 1) + "…" : text.slice(0, width);
   }
   return text + " ".repeat(width - text.length);
}

export function visibleColumns(columns: Column[], leftCol: number, width: number): Column[]
{
   const out: Column[] = [];
   let used = 0;
   for (let i = leftCol; i < columns.length; i++)
   {
      const column = columns[i]!;
      if (used + column.width + 1 > width && out.length > 0)
      {
         break;
      }
      out.push(column);
      used += column.width + 1;
   }
   return out;
}

export function Grid({ rows, columns, width, height, active }: GridProps)
{
   const renderer = useRenderer();
   const [cursorRow, setCursorRow] = useState(0);
   const [cursorCol, setCursorCol] = useState(0);
   const [topRow, setTopRow] = useState(0);
   const [leftCol, setLeftCol] = useState(0);
   const [sortCol, setSortCol] = useState<number | null>(null);
   const [sortDir, setSortDir] = useState<SortDirection>("asc");
   const [sortMs, setSortMs] = useState<number | null>(null);
   const pendingKey = useRef<{ name: string; at: number } | null>(null);

   const sorted = useMemo(() =>
   {
      if (sortCol === null)
      {
         return rows;
      }
      const started = performance.now();
      const result = sortRows(rows, columns[sortCol]!, sortDir);
      const ms = performance.now() - started;
      record("sort", ms);
      queueMicrotask(() => setSortMs(ms));
      return result;
   }, [rows, columns, sortCol, sortDir]);

   useEffect(() =>
   {
      const onFrame = () =>
      {
         const pending = pendingKey.current;
         if (pending)
         {
            pendingKey.current = null;
            record(`key:${pending.name}`, performance.now() - pending.at);
         }
      };
      renderer.on("frame", onFrame);
      return () =>
      {
         renderer.off("frame", onFrame);
      };
   }, [renderer]);

   const bodyRows = Math.max(1, height);
   const total = sorted.length;

   function moveTo(row: number)
   {
      const next = Math.max(0, Math.min(total - 1, row));
      setCursorRow(next);
      setTopRow((top) =>
      {
         if (next < top)
         {
            return next;
         }
         if (next >= top + bodyRows)
         {
            return next - bodyRows + 1;
         }
         return top;
      });
   }

   function moveCol(col: number)
   {
      const next = Math.max(0, Math.min(columns.length - 1, col));
      setCursorCol(next);
      setLeftCol((left) =>
      {
         if (next < left)
         {
            return next;
         }
         let l = left;
         while (l < next && !visibleColumns(columns, l, width).includes(columns[next]!))
         {
            l++;
         }
         return l;
      });
   }

   useKeyboard((key: KeyEvent) =>
   {
      if (!active)
      {
         return;
      }
      const started = performance.now();
      switch (key.name)
      {
         case "down": moveTo(cursorRow + 1); break;
         case "up": moveTo(cursorRow - 1); break;
         case "pagedown": moveTo(cursorRow + bodyRows); break;
         case "pageup": moveTo(cursorRow - bodyRows); break;
         case "home": moveTo(0); break;
         case "end": moveTo(total - 1); break;
         case "right": moveCol(cursorCol + 1); break;
         case "left": moveCol(cursorCol - 1); break;
         case "s":
            if (sortCol === cursorCol)
            {
               setSortDir(sortDir === "asc" ? "desc" : "asc");
            }
            else
            {
               setSortCol(cursorCol);
               setSortDir("asc");
            }
            moveTo(0);
            break;
         default:
            return;
      }
      pendingKey.current = { name: key.name, at: started };
   });

   const cols = visibleColumns(columns, leftCol, width);
   const header = cols.map((c, i) =>
   {
      const marker = sortCol !== null && columns[sortCol] === c ? (sortDir === "asc" ? "▲" : "▼") : " ";
      return pad(c.label + marker, c.width) + (i < cols.length - 1 ? " " : "");
   }).join("");

   const lines: { text: string; selected: boolean }[] = [];
   for (let r = topRow; r < Math.min(total, topRow + bodyRows); r++)
   {
      const row = sorted[r]!;
      const text = cols.map((c, i) => pad(formatCell(row[c.name], c), c.width) + (i < cols.length - 1 ? " " : "")).join("");
      lines.push({ text, selected: r === cursorRow });
   }
   while (lines.length < bodyRows)
   {
      lines.push({ text: "", selected: false });
   }

   const lastKey = lastOf(`key:${pendingKey.current?.name ?? "down"}`);
   const status = `row ${cursorRow + 1} of ${total} · col ${cursorCol + 1}/${columns.length} ${columns[cursorCol]!.label}`
      + (sortCol !== null ? ` · sort ${columns[sortCol]!.label} ${sortDir}` : "")
      + (sortMs !== null ? ` (${sortMs.toFixed(1)} ms)` : "")
      + (lastKey !== undefined ? ` · key→frame ${lastKey.toFixed(1)} ms` : "");

   return (
      <box flexDirection="column" width={width} height={height + 2}>
         <text fg={GRID_COLORS.header}>{pad(header, width)}</text>
         {lines.map((line, i) => (
            <text
               key={i}
               fg={line.selected ? GRID_COLORS.selectedFg : GRID_COLORS.text}
               bg={line.selected ? GRID_COLORS.selectedBg : undefined}
            >
               {pad(line.text, width)}
            </text>
         ))}
         <text fg={GRID_COLORS.dim}>{pad(status, width)}</text>
      </box>
   );
}
