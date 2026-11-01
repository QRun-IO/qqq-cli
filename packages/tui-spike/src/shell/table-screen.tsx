// Server-paged query grid for a real table: one page from POST /table/{name}/query, count from /count.

import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import type { FieldMetaData, QRecord, QueryFilter, ShellApi, TableMetaData } from "../api";
import { pad, visibleColumns } from "../grid";
import type { Column } from "../data";
import { T } from "./theme";

export interface Criterion
{
   fieldName: string;
   operator: string;
   values: unknown[];
}

export interface TableScreenProps
{
   api: ShellApi;
   table: string;
   width: number;
   height: number;
   active: boolean;
   criteria: Criterion[];
   refreshToken: number;
   onOpenRecord: (pk: string | number, label: string) => void;
   onCursorRecord: (pk: string | number | null, label: string) => void;
   onMessage: (text: string, kind?: "info" | "err") => void;
}

export function columnsFor(meta: TableMetaData): Column[]
{
   const order: string[] = [meta.primaryKeyField];
   for (const tier of ["T1", "T2", "T3"])
   {
      for (const s of meta.sections.filter((x) => x.tier === tier))
      {
         for (const f of s.fieldNames ?? [])
         {
            if (!order.includes(f) && meta.fields[f]) order.push(f);
         }
      }
   }
   for (const f of Object.keys(meta.fields))
   {
      if (!order.includes(f)) order.push(f);
   }
   return order.map((name) =>
   {
      const f = meta.fields[name] as FieldMetaData;
      const base = f.possibleValueSourceName ? 18 : f.type === "INTEGER" ? 8 : f.type === "DECIMAL" ? 13 : f.type === "BOOLEAN" ? 6 : f.type === "DATE" ? 11 : f.type === "DATE_TIME" ? 20 : f.type === "TEXT" ? 30 : 16;
      return { name, label: f.label, width: Math.max(base, f.label.length + 1), type: f.type === "INTEGER" || f.type === "DECIMAL" ? "number" : "string" };
   });
}

export function TableScreen(p: TableScreenProps)
{
   const { api, table, width, height, active, criteria, refreshToken, onOpenRecord, onCursorRecord, onMessage } = p;
   const [meta, setMeta] = useState<TableMetaData | null>(null);
   const [rows, setRows] = useState<QRecord[]>([]);
   const [total, setTotal] = useState<number | null>(null);
   const [skip, setSkip] = useState(0);
   const [cursor, setCursor] = useState(0);
   const [cursorCol, setCursorCol] = useState(0);
   const [leftCol, setLeftCol] = useState(0);
   const [sort, setSort] = useState<{ field: string; asc: boolean } | null>(null);
   const [loading, setLoading] = useState(false);
   const [fetchMs, setFetchMs] = useState<number | null>(null);
   const limit = Math.max(1, height - 2);
   const columns = meta ? columnsFor(meta) : [];
   const generation = useRef(0);

   useEffect(() =>
   {
      setMeta(null); setRows([]); setSkip(0); setCursor(0); setSort(null); setCursorCol(0); setLeftCol(0); setTotal(null);
      api.tableMeta(table).then(setMeta).catch((e) => onMessage(String(e), "err"));
   }, [table]);

   useEffect(() =>
   {
      if (!meta)
      {
         return;
      }
      const gen = ++generation.current;
      const filter: QueryFilter = { criteria, orderBys: [{ fieldName: sort?.field ?? meta.primaryKeyField, isAscending: sort ? sort.asc : true }], skip, limit };
      setLoading(true);
      const t = performance.now();
      Promise.all([api.query(table, filter), api.count(table, filter)]).then(([recs, count]) =>
      {
         if (gen !== generation.current) return;
         setRows(recs); setTotal(count); setFetchMs(performance.now() - t); setLoading(false);
         setCursor((c) => Math.min(c, Math.max(0, recs.length - 1)));
      }).catch((e) =>
      {
         if (gen !== generation.current) return;
         setLoading(false); onMessage(String(e), "err");
      });
   }, [meta, table, skip, limit, sort, criteria, refreshToken]);

   useEffect(() =>
   {
      const r = rows[cursor];
      onCursorRecord(r && meta ? (r.values[meta.primaryKeyField] as string | number) : null, r?.recordLabel ?? "");
   }, [rows, cursor, meta]);

   const pageCount = total === null ? 1 : Math.max(1, Math.ceil(total / limit));
   const page = Math.floor(skip / limit);

   function moveCol(col: number)
   {
      const next = Math.max(0, Math.min(columns.length - 1, col));
      setCursorCol(next);
      setLeftCol((left) =>
      {
         if (next < left) return next;
         let l = left;
         while (l < next && !visibleColumns(columns, l, width - 2).includes(columns[next]!)) l++;
         return l;
      });
   }

   useKeyboard((key: KeyEvent) =>
   {
      if (!active || !meta)
      {
         return;
      }
      switch (key.name)
      {
         case "down":
            if (cursor < rows.length - 1) setCursor(cursor + 1);
            else if (page < pageCount - 1) { setSkip(skip + limit); setCursor(0); }
            break;
         case "up":
            if (cursor > 0) setCursor(cursor - 1);
            else if (page > 0) { setSkip(skip - limit); setCursor(limit - 1); }
            break;
         case "pagedown": if (page < pageCount - 1) { setSkip(skip + limit); setCursor(0); } else setCursor(rows.length - 1); break;
         case "pageup": if (page > 0) { setSkip(skip - limit); setCursor(0); } else setCursor(0); break;
         case "home": setSkip(0); setCursor(0); break;
         case "end": setSkip((pageCount - 1) * limit); setCursor(Math.max(0, Math.min(limit, (total ?? 0) - (pageCount - 1) * limit) - 1)); break;
         case "right": moveCol(cursorCol + 1); break;
         case "left": moveCol(cursorCol - 1); break;
         case "return": {
            const r = rows[cursor];
            if (r) onOpenRecord(r.values[meta.primaryKeyField] as string | number, r.recordLabel ?? "");
            break;
         }
         case "s": {
            const field = columns[cursorCol]!.name;
            setSort(sort && sort.field === field ? { field, asc: !sort.asc } : { field, asc: true });
            setSkip(0); setCursor(0);
            break;
         }
         default: break;
      }
   });

   const inner = width - 2;
   const cols = visibleColumns(columns, leftCol, inner);
   const header = cols.map((c, i) =>
   {
      const marker = sort?.field === c.name ? (sort.asc ? "▲" : "▼") : " ";
      const hot = i + leftCol === cursorCol;
      return (hot ? "[" : " ") + pad(c.label + marker, c.width - 1) + (hot ? "]" : " ");
   }).join("");
   const lines = rows.map((r, i) =>
   {
      const text = cols.map((c) => " " + pad(r.displayValues[c.name] ?? String(r.values[c.name] ?? ""), c.width)).join("");
      return <text key={i} fg={i === cursor ? T.selFg : T.fg} bg={i === cursor && active ? T.selBg : undefined}>{pad(text, inner)}</text>;
   });
   while (lines.length < limit)
   {
      lines.push(<text key={`e${lines.length}`}>{pad(lines.length === 0 && !loading && meta ? "  (no records)" : "", inner)}</text>);
   }
   const crit = criteria.length ? criteria.map((c) => `${c.fieldName} ${c.operator} ${c.values.join(",")}`).join(" AND ") : "no filter";
   const status = `${total === null ? "…" : total.toLocaleString()} records · page ${page + 1}/${pageCount} · ${crit}` + (sort ? ` · sort ${sort.field} ${sort.asc ? "asc" : "desc"}` : "") + (fetchMs !== null ? ` · ${fetchMs.toFixed(0)} ms` : "") + (loading ? " · loading" : "");
   return (
      <box flexDirection="column" width={width} height={height + 2} border borderColor={active ? T.focusBorder : T.border} title={` ${meta?.label ?? table} `}>
         <text fg={T.acc}>{pad(header, inner)}</text>
         {lines}
         <text fg={T.dim}>{pad(status, inner)}</text>
      </box>
   );
}
