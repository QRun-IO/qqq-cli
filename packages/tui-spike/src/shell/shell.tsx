// Classic-TUI shell: title bar, app tree, content, live status line, function-key bar, overlays.

import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { ShellApi, type AppTreeNode, type AuthMetaData, type MetaDataResponse, type RealtimeState, type VersionResponse } from "../api";
import { pad } from "../grid";
import { ProcessScreen } from "../process";
import { FKeyBar, StatusLine, type StatusInfo } from "./footer";
import { ScreenErrorBoundary } from "./error-boundary";
import { ConfirmOverlay, GotoOverlay, HelpOverlay, MenuOverlay, MessageOverlay, PromptOverlay, setOverlayScreenWidth, type GotoItem } from "./overlays";
import { RecordScreen } from "./record-screen";
import { Sidebar, flatten } from "./sidebar";
import { TableScreen, type Criterion } from "./table-screen";
import { T } from "./theme";

const BASE = (process.env.QQQ_SERVER ?? "http://localhost:8077") + "/qqq/v1";

type Route =
   | { kind: "home" }
   | { kind: "table"; table: string; criteria: Criterion[] }
   | { kind: "record"; table: string; pk: string | number; label: string }
   | { kind: "process"; process: string };

type Overlay =
   | null
   | { kind: "help" }
   | { kind: "goto" }
   | { kind: "menu" }
   | { kind: "confirm"; text: string; onYes: () => void }
   | { kind: "prompt"; title: string; hint: string; initial?: string; onSubmit: (v: string) => void }
   | { kind: "message"; text: string; mkind: "info" | "err" };

export function parseCriterion(text: string): Criterion | null
{
   const m = /^\s*(\S+)\s+([A-Z_]+)\s*(.*)$/.exec(text);
   if (!m) return null;
   const raw = m[3]!.trim();
   const values = raw === "" ? [] : raw.split(",").map((v) => v.trim()).map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v));
   return { fieldName: m[1]!, operator: m[2]!, values };
}

export function Shell()
{
   const renderer = useRenderer();
   const { width, height } = useTerminalDimensions();
   const api = useRef(new ShellApi(BASE));
   const [meta, setMeta] = useState<MetaDataResponse | null>(null);
   const [routes, setRoutes] = useState<Route[]>([{ kind: "home" }]);
   const [focus, setFocus] = useState<"sidebar" | "content">("sidebar");
   const [overlay, setOverlay] = useState<Overlay>(null);
   const [expanded, setExpanded] = useState<Set<string>>(new Set());
   const [sideCursor, setSideCursor] = useState(0);
   const [refreshToken, setRefreshToken] = useState(0);
   const cursorPk = useRef<{ pk: string | number | null; label: string }>({ pk: null, label: "" });
   const [status, setStatus] = useState<StatusInfo>({ server: BASE.replace("/qqq/v1", ""), apiVersion: "…", auth: "…", sessionShort: "", pingMs: null, stream: "connecting", lastEvent: "no events yet", jobs: "n/a", clock: "", build: process.env.QQQ_SPIKE_BUILD ?? "dev" });
   const [bootError, setBootError] = useState<string | null>(null);

   const route = routes[routes.length - 1]!;
   setOverlayScreenWidth(width);

   function patchStatus(p: Partial<StatusInfo>)
   {
      setStatus((s) => ({ ...s, ...p }));
   }

   useEffect(() =>
   {
      let stopStream: (() => void) | null = null;
      (async () =>
      {
         try
         {
            const version = await api.current.get<VersionResponse>("/version");
            const auth = await api.current.get<AuthMetaData>("/metaData/authentication");
            if (auth.type !== "MOCK" && auth.type !== "FULLY_ANONYMOUS") throw new Error(`spike only handles MOCK/FULLY_ANONYMOUS auth, server says ${auth.type}`);
            const token = await api.current.manageSession();
            const m = await api.current.metaData();
            setMeta(m);
            setExpanded(new Set(m.appTree.map((n) => "/" + n.name)));
            patchStatus({ apiVersion: version.apiVersion, auth: auth.type.toLowerCase(), sessionShort: token.slice(0, 8), jobs: version.features.includes("durableJobs") ? "0" : "n/a" });
            api.current.get<unknown>("/jobs?scope=mine&state=active").then((r) => patchStatus({ jobs: String((r as { activeCount?: number }).activeCount ?? 0) })).catch(() => patchStatus({ jobs: "n/a" }));
            stopStream = api.current.realtime((s: RealtimeState) => patchStatus({ stream: s }), (name) => patchStatus({ lastEvent: `${name} @ ${new Date().toLocaleTimeString("en-GB")}` }));
         }
         catch (e)
         {
            setBootError(e instanceof Error ? e.message : String(e));
         }
      })();
      const pingTimer = setInterval(() => { api.current.ping().then((ms) => patchStatus({ pingMs: ms })).catch(() => patchStatus({ pingMs: null })); }, 5000);
      api.current.ping().then((ms) => patchStatus({ pingMs: ms })).catch(() => undefined);
      const clockTimer = setInterval(() => patchStatus({ clock: new Date().toLocaleTimeString("en-GB") }), 1000);
      return () => { clearInterval(pingTimer); clearInterval(clockTimer); stopStream?.(); };
   }, []);

   const gotoItems = useMemo<GotoItem[]>(() =>
   {
      if (!meta) return [];
      const out: GotoItem[] = [];
      const walk = (nodes: AppTreeNode[], path: string[]) =>
      {
         for (const n of nodes)
         {
            if (n.type === "TABLE" || n.type === "PROCESS") out.push({ kind: n.type, name: n.name, label: n.label, path: path.join(" › ") });
            if (n.children) walk(n.children, [...path, n.label]);
         }
      };
      walk(meta.appTree, []);
      return out;
   }, [meta]);

   function push(r: Route) { setRoutes((rs) => [...rs, r]); setFocus("content"); }
   function pop() { setRoutes((rs) => (rs.length > 1 ? rs.slice(0, -1) : rs)); }
   function message(text: string, mkind: "info" | "err" = "info") { setOverlay({ kind: "message", text, mkind }); }
   function openNode(n: AppTreeNode)
   {
      if (n.type === "TABLE") push({ kind: "table", table: n.name, criteria: [] });
      else if (n.type === "PROCESS") push({ kind: "process", process: n.name });
      else message(`${n.type} ${n.label}: not in this spike`);
   }

   function runCommand(line: string)
   {
      const [cmd, ...rest] = line.trim().split(/\s+/);
      const arg = rest.join(" ");
      switch (cmd)
      {
         case "table": {
            const [name, ...crit] = rest;
            if (!name || !meta?.tables[name]) return message(`unknown table "${name ?? ""}"`, "err");
            const c = crit.length ? parseCriterion(crit.join(" ")) : null;
            if (crit.length && !c) return message("filter must be: field OPERATOR value[,value]", "err");
            push({ kind: "table", table: name, criteria: c ? [c] : [] });
            break;
         }
         case "record": {
            const [name, pk] = rest;
            if (!name || !pk || !meta?.tables[name]) return message("usage: record <table> <pk>", "err");
            push({ kind: "record", table: name, pk, label: "" });
            break;
         }
         case "process":
            if (!arg || !meta?.processes[arg]) return message(`unknown process "${arg}"`, "err");
            push({ kind: "process", process: arg });
            break;
         case "filter":
            if (route.kind !== "table") return message("filter applies on a table screen", "err");
            applyFilter(arg);
            break;
         case "home": setRoutes([{ kind: "home" }]); setFocus("sidebar"); break;
         case "quit": renderer.destroy(); break;
         case "": break;
         default: message(`unknown command "${cmd}" (F1 lists them)`, "err");
      }
   }

   function applyFilter(text: string)
   {
      if (route.kind !== "table") return;
      if (text.trim() === "") return setRoutes((rs) => [...rs.slice(0, -1), { ...route, criteria: [] }]);
      const c = parseCriterion(text);
      if (!c) return message("filter must be: field OPERATOR value[,value]   e.g. lastName STARTS_WITH S", "err");
      setRoutes((rs) => [...rs.slice(0, -1), { ...route, criteria: [c] }]);
   }

   function deleteUnderCursor()
   {
      const target = route.kind === "record" ? { table: route.table, pk: route.pk, label: route.label } : route.kind === "table" && cursorPk.current.pk !== null ? { table: route.table, pk: cursorPk.current.pk, label: cursorPk.current.label } : null;
      if (!target) return message("nothing selected to delete");
      setOverlay({ kind: "confirm", text: `Delete ${meta?.tables[target.table]?.label ?? target.table} ${target.pk}${target.label ? ` "${target.label}"` : ""}?`, onYes: () =>
      {
         setOverlay(null);
         api.current.deleteRecord(target.table, target.pk).then(() =>
         {
            if (route.kind === "record") pop();
            setRefreshToken((n) => n + 1);
         }).catch((e) => message(String(e), "err"));
      } });
   }

   useKeyboard((key: KeyEvent) =>
   {
      if (overlay) return;
      switch (key.name)
      {
         case "f1": setOverlay({ kind: "help" }); break;
         case "f2": setOverlay({ kind: "goto" }); break;
         case "f3":
            if (route.kind === "table" && cursorPk.current.pk !== null) push({ kind: "record", table: route.table, pk: cursorPk.current.pk, label: cursorPk.current.label });
            else message("F3 views the record under the cursor on a table screen");
            break;
         case "f4": message("Edit arrives in M3 (form engine with contingent fields)"); break;
         case "f5": setRefreshToken((n) => n + 1); break;
         case "f6":
            if (route.kind !== "table") return message("F6 filters a table screen");
            setOverlay({ kind: "prompt", title: `Filter ${meta?.tables[route.table]?.label ?? route.table}`, hint: "field OPERATOR value[,value] · operators: EQUALS NOT_EQUALS CONTAINS STARTS_WITH GREATER_THAN LESS_THAN BETWEEN IN IS_BLANK · empty clears", initial: route.criteria[0] ? `${route.criteria[0].fieldName} ${route.criteria[0].operator} ${route.criteria[0].values.join(",")}` : "", onSubmit: (v) => { setOverlay(null); applyFilter(v); } });
            break;
         case "f7": message("New record arrives in M3"); break;
         case "f8": deleteUnderCursor(); break;
         case "f9": setOverlay({ kind: "menu" }); break;
         case "f10": renderer.destroy(); break;
         case "escape": if (routes.length > 1) pop(); else setFocus("sidebar"); break;
         case "tab": setFocus((f) => (f === "sidebar" ? "content" : "sidebar")); break;
         default:
            if (key.sequence === ":") setOverlay({ kind: "prompt", title: "Command", hint: "table <name> [field OP value] · record <table> <pk> · process <name> · filter … · home · quit", onSubmit: (v) => { setOverlay(null); runCommand(v); } });
      }
   });

   const sidebarWidth = width >= 100 ? 30 : width >= 80 ? 24 : 0;
   const bodyHeight = Math.max(5, height - 3);
   const contentWidth = width - sidebarWidth;
   const brand = meta?.branding?.appName ?? "QQQ";
   const crumbs = route.kind === "home" ? "Home" : route.kind === "table" ? meta?.tables[route.table]?.label ?? route.table : route.kind === "record" ? `${meta?.tables[route.table]?.label ?? route.table} › ${route.label || route.pk}` : meta?.processes[route.process]?.label ?? route.process;
   const title = ` ${brand} ─ ${crumbs}`;
   const contentActive = focus === "content" && !overlay;
   const fkeys = [
      { n: 1, label: "Help" }, { n: 2, label: "Go to" }, { n: 3, label: "View", enabled: route.kind === "table" },
      { n: 4, label: "Edit", enabled: false }, { n: 5, label: "Refresh" }, { n: 6, label: "Filter", enabled: route.kind === "table" },
      { n: 7, label: "New", enabled: false }, { n: 8, label: "Delete", enabled: route.kind === "table" || route.kind === "record" }, { n: 9, label: "Menu" }, { n: 10, label: "Quit" },
   ];

   let content: React.ReactNode;
   if (bootError) content = <box border borderColor={T.err} width={contentWidth} height={bodyHeight}><text fg={T.err}>{` cannot connect: ${bootError}`}</text><text fg={T.dim}>{` server ${BASE} · start it with: qqq-sample-server start · F10 quits`}</text></box>;
   else if (!meta) content = <box border borderColor={T.border} width={contentWidth} height={bodyHeight}><text fg={T.dim}>{" connecting…"}</text></box>;
   else if (route.kind === "home")
   {
      const tables = Object.values(meta.tables).filter((t) => !t.isHidden).length;
      const processes = Object.values(meta.processes).filter((p) => !p.isHidden).length;
      content = (
         <box flexDirection="column" border borderColor={contentActive ? T.focusBorder : T.border} width={contentWidth} height={bodyHeight} title=" Home ">
            <text fg={T.acc}>{` ${brand}`}</text>
            <text>{` ${meta.appTree.length} apps · ${tables} tables · ${processes} processes · UI API ${status.apiVersion}`}</text>
            <text fg={T.dim}>{""}</text>
            <text fg={T.dim}>{" Tab to the Apps tree and press Enter on a table, or F2 to go anywhere by name."}</text>
            <text fg={T.dim}>{" Try:  :table person lastName STARTS_WITH S     F6 on a table     F8 deletes (data resets on server restart)"}</text>
         </box>
      );
   }
   else if (route.kind === "table") content = <TableScreen key={`t:${route.table}`} api={api.current} table={route.table} width={contentWidth} height={bodyHeight - 2} active={contentActive} criteria={route.criteria} refreshToken={refreshToken} onOpenRecord={(pk, label) => push({ kind: "record", table: route.table, pk, label })} onCursorRecord={(pk, label) => { cursorPk.current = { pk, label }; }} onMessage={message} />;
   else if (route.kind === "record") content = <RecordScreen key={`r:${route.table}:${route.pk}`} api={api.current} table={route.table} pk={route.pk} width={contentWidth} height={bodyHeight - 2} active={contentActive} refreshToken={refreshToken} onMessage={message} />;
   else content = <box flexDirection="column" border borderColor={contentActive ? T.focusBorder : T.border} width={contentWidth} height={bodyHeight} title={` ${meta.processes[route.process]?.label ?? route.process} `}><ProcessScreen key={`p:${route.process}`} width={contentWidth - 2} active={contentActive} processName={route.process} api={api.current} /></box>;

   return (
      <box flexDirection="column" width={width} height={height}>
         <text fg={T.titleFg} bg={T.titleBg}>{pad(title, width)}</text>
         <box flexDirection="row" width={width} height={bodyHeight}>
            {sidebarWidth > 0 && meta && (
               <Sidebar nodes={meta.appTree} expanded={expanded} cursor={sideCursor} width={sidebarWidth} height={bodyHeight - 2} active={focus === "sidebar" && !overlay}
                  currentName={route.kind === "table" || route.kind === "record" ? route.table : route.kind === "process" ? route.process : undefined}
                  onCursor={setSideCursor}
                  onToggle={(path, open) => setExpanded((s) => { const n = new Set(s); if (open) n.add(path); else n.delete(path); return n; })}
                  onOpen={openNode} />
            )}
            {sidebarWidth === 0 && meta && <box width={0} height={0} />}
            <ScreenErrorBoundary width={contentWidth} resetKey={`${JSON.stringify(route)}:${refreshToken}`}>{content}</ScreenErrorBoundary>
         </box>
         <StatusLine width={width} info={status} />
         <FKeyBar width={width} keys={fkeys} />
         {overlay?.kind === "help" && <HelpOverlay width={Math.min(76, width - 4)} onClose={() => setOverlay(null)} />}
         {overlay?.kind === "goto" && <GotoOverlay width={Math.min(76, width - 4)} items={gotoItems} onPick={(it) => { setOverlay(null); if (it.kind === "TABLE") push({ kind: "table", table: it.name, criteria: [] }); else push({ kind: "process", process: it.name }); }} onClose={() => setOverlay(null)} />}
         {overlay?.kind === "menu" && <MenuOverlay items={[
            { label: "Home", action: () => { setRoutes([{ kind: "home" }]); setFocus("sidebar"); } },
            { label: "Go to…  (F2)", action: () => setOverlay({ kind: "goto" }) },
            { label: "Refresh  (F5)", action: () => setRefreshToken((n) => n + 1) },
            { label: "Help  (F1)", action: () => setOverlay({ kind: "help" }) },
            { label: "Quit  (F10)", action: () => renderer.destroy() },
         ]} onPick={(a) => { setOverlay(null); a(); }} onClose={() => setOverlay(null)} />}
         {overlay?.kind === "confirm" && <ConfirmOverlay text={overlay.text} onYes={overlay.onYes} onNo={() => setOverlay(null)} />}
         {overlay?.kind === "prompt" && <PromptOverlay title={overlay.title} hint={overlay.hint} initial={overlay.initial} onSubmit={overlay.onSubmit} onClose={() => setOverlay(null)} />}
         {overlay?.kind === "message" && <MessageOverlay text={overlay.text} kind={overlay.mkind} onClose={() => setOverlay(null)} />}
      </box>
   );
}

export { flatten };
