import { useKeyboard } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";
import type { AppTreeNode } from "../api";
import { pad } from "../grid";
import { T } from "./theme";

export interface FlatNode
{
   node: AppTreeNode;
   depth: number;
   expanded: boolean;
   path: string;
}

export function flatten(nodes: AppTreeNode[], expanded: Set<string>, depth = 0, prefix = ""): FlatNode[]
{
   const out: FlatNode[] = [];
   for (const n of nodes)
   {
      const path = prefix + "/" + n.name;
      const isOpen = expanded.has(path);
      out.push({ node: n, depth, expanded: isOpen, path });
      if (isOpen && n.children?.length)
      {
         out.push(...flatten(n.children, expanded, depth + 1, path));
      }
   }
   return out;
}

export interface SidebarProps
{
   nodes: AppTreeNode[];
   expanded: Set<string>;
   cursor: number;
   width: number;
   height: number;
   active: boolean;
   currentName?: string;
   onCursor: (i: number) => void;
   onToggle: (path: string, open: boolean) => void;
   onOpen: (node: AppTreeNode) => void;
}

export function Sidebar({ nodes, expanded, cursor, width, height, active, currentName, onCursor, onToggle, onOpen }: SidebarProps)
{
   const flat = flatten(nodes, expanded);
   const top = Math.max(0, Math.min(cursor - Math.floor(height / 2), flat.length - height));

   useKeyboard((key: KeyEvent) =>
   {
      if (!active || flat.length === 0)
      {
         return;
      }
      const cur = flat[cursor];
      switch (key.name)
      {
         case "down": onCursor(Math.min(flat.length - 1, cursor + 1)); break;
         case "up": onCursor(Math.max(0, cursor - 1)); break;
         case "pagedown": onCursor(Math.min(flat.length - 1, cursor + height)); break;
         case "pageup": onCursor(Math.max(0, cursor - height)); break;
         case "home": onCursor(0); break;
         case "end": onCursor(flat.length - 1); break;
         case "right":
            if (cur && cur.node.children?.length) onToggle(cur.path, true);
            break;
         case "left":
            if (cur && cur.expanded) onToggle(cur.path, false);
            else if (cur && cur.depth > 0) onCursor(flat.findIndex((f) => f.path === cur.path.slice(0, cur.path.lastIndexOf("/"))));
            break;
         case "return":
         case "space":
            if (!cur) break;
            if (cur.node.children?.length) onToggle(cur.path, !cur.expanded);
            else onOpen(cur.node);
            break;
         default: break;
      }
   });

   const inner = width - 2;
   const lines = flat.slice(top, top + height).map((f, i) =>
   {
      const idx = top + i;
      const glyph = f.node.children?.length ? (f.expanded ? "▾ " : "▸ ") : "  ";
      const marker = f.node.type === "TABLE" ? "" : f.node.type === "PROCESS" ? "▷ " : f.node.type === "REPORT" ? "≡ " : "";
      const text = pad(" ".repeat(f.depth) + glyph + marker + f.node.label, inner - 1) + (f.node.name === currentName ? "◂" : " ");
      const selected = idx === cursor;
      return (
         <text key={f.path} fg={selected && active ? T.selFg : f.node.type === "APP" ? T.fg : T.dim} bg={selected && active ? T.selBg : undefined}>
            {text}
         </text>
      );
   });
   while (lines.length < height)
   {
      lines.push(<text key={`pad${lines.length}`}>{pad("", inner)}</text>);
   }
   return (
      <box flexDirection="column" width={width} height={height + 2} border borderColor={active ? T.focusBorder : T.border} title={active ? " Apps " : " Apps (Tab) "}>
         {lines}
      </box>
   );
}
