import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { pad } from "../grid";
import { T } from "./theme";

let screenWidth = 100;
export function setOverlayScreenWidth(w: number) { screenWidth = w; }

export function Frame({ title, width, children }: { title: string; width: number; children: React.ReactNode })
{
   return (
      <box position="absolute" left={Math.max(1, Math.floor((screenWidth - width) / 2))} top={3} width={width} flexDirection="column" border borderStyle="double" borderColor={T.acc} backgroundColor={T.overlayBg} title={` ${title} `} zIndex={10}>
         {children}
      </box>
   );
}

export function HelpOverlay({ width, onClose }: { width: number; onClose: () => void })
{
   useKeyboard((k: KeyEvent) => { if (k.name === "escape" || k.name === "return" || k.name === "f1") onClose(); });
   const rows = [
      ["F1", "help (this)", "Esc", "back / close"],
      ["F2", "go to table or process", "Tab", "Apps tree / content"],
      ["F3", "view record under cursor", "Enter", "open"],
      ["F4", "edit (M3)", "↑↓ PgUp PgDn", "move, page"],
      ["F5", "refresh", "Home End", "first, last"],
      ["F6", "filter: field OP value", "← →", "columns, tree"],
      ["F7", "new record (M3)", "s", "sort by column"],
      ["F8", "delete record (confirm)", ":", "command line"],
      ["F9", "menu", "F10", "quit (Ctrl+C too)"],
   ];
   return (
      <Frame title="Help" width={width}>
         {rows.map((r, i) => <text key={i}><span fg={T.keyLabelFg}>{pad(" " + r[0]!, 5)}</span><span fg={T.fg}>{pad(r[1]!, 28)}</span><span fg={T.keyLabelFg}>{pad(r[2]!, 14)}</span><span fg={T.fg}>{pad(r[3]!, 22)}</span></text>)}
         <text fg={T.dim}>{""}</text>
         <text fg={T.dim}>{" :table <name> [field OP value]   :record <table> <pk>   :process <name>   :home   :quit".slice(0, 72)}</text>
      </Frame>
   );
}

export interface GotoItem
{
   kind: "TABLE" | "PROCESS";
   name: string;
   label: string;
   path: string;
}

export function GotoOverlay({ width, items, onPick, onClose }: { width: number; items: GotoItem[]; onPick: (it: GotoItem) => void; onClose: () => void })
{
   const [q, setQ] = useState("");
   const [idx, setIdx] = useState(0);
   const needle = q.toLowerCase();
   const matches = items.filter((it) => !needle || it.label.toLowerCase().includes(needle) || it.name.toLowerCase().includes(needle) || it.path.toLowerCase().includes(needle)).slice(0, 12);
   useKeyboard((k: KeyEvent) =>
   {
      if (k.name === "escape") onClose();
      else if (k.name === "down") setIdx((i) => Math.min(matches.length - 1, i + 1));
      else if (k.name === "up") setIdx((i) => Math.max(0, i - 1));
      else if (k.name === "return" && matches[idx]) onPick(matches[idx]!);
   });
   return (
      <Frame title="Go to  (F2)" width={width}>
         <box backgroundColor={T.selBg}><input focused value={q} placeholder="type a table or process name" onInput={(v: string) => { setQ(v); setIdx(0); }} /></box>
         {matches.map((m, i) => <text key={m.kind + m.name} fg={i === idx ? T.selFg : T.fg} bg={i === idx ? T.selBg : undefined}>{pad(`${i === idx ? "▶" : " "} ${pad(m.label, 28)} ${pad(m.kind.toLowerCase(), 8)} ${m.path}`, width - 2)}</text>)}
         <text fg={T.dim}>{`${matches.length} shown · ↑↓ Enter · Esc`}</text>
      </Frame>
   );
}

export function MenuOverlay({ items, onPick, onClose }: { items: { label: string; action: () => void }[]; onPick: (a: () => void) => void; onClose: () => void })
{
   const [idx, setIdx] = useState(0);
   useKeyboard((k: KeyEvent) =>
   {
      if (k.name === "escape" || k.name === "f9") onClose();
      else if (k.name === "down") setIdx((i) => (i + 1) % items.length);
      else if (k.name === "up") setIdx((i) => (i + items.length - 1) % items.length);
      else if (k.name === "return") onPick(items[idx]!.action);
   });
   return (
      <Frame title="Menu  (F9)" width={34}>
         {items.map((it, i) => <text key={it.label} fg={i === idx ? T.selFg : T.fg} bg={i === idx ? T.selBg : undefined}>{pad(` ${it.label}`, 32)}</text>)}
      </Frame>
   );
}

export function ConfirmOverlay({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void })
{
   useKeyboard((k: KeyEvent) =>
   {
      if (k.name === "y" || k.name === "return") onYes();
      else if (k.name === "n" || k.name === "escape") onNo();
   });
   return (
      <Frame title="Confirm" width={Math.min(90, Math.max(38, text.length + 4))}>
         <text fg={T.warn}>{` ${text}`}</text>
         <text fg={T.dim}>{" y / Enter = yes    n / Esc = no"}</text>
      </Frame>
   );
}

export function PromptOverlay({ title, hint, initial, onSubmit, onClose }: { title: string; hint: string; initial?: string; onSubmit: (v: string) => void; onClose: () => void })
{
   const [v, setV] = useState(initial ?? "");
   useKeyboard((k: KeyEvent) => { if (k.name === "escape") onClose(); });
   return (
      <Frame title={title} width={80}>
         <box backgroundColor={T.selBg}><input focused value={v} onInput={setV} onSubmit={() => onSubmit(v)} /></box>
         <text fg={T.dim}>{` ${hint}`}</text>
      </Frame>
   );
}

export function MessageOverlay({ text, kind, onClose }: { text: string; kind: "info" | "err"; onClose: () => void })
{
   useKeyboard(() => onClose());
   return (
      <Frame title={kind === "err" ? "Error" : "Message"} width={Math.min(100, Math.max(30, text.length + 4))}>
         <text fg={kind === "err" ? T.err : T.fg}>{` ${text}`}</text>
         <text fg={T.dim}>{" any key"}</text>
      </Frame>
   );
}
