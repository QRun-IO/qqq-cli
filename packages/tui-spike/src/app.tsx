// Spike shell: three screens (grid, form, process), a title line and a status line.

import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useMemo, useState } from "react";
import type { KeyEvent } from "@opentui/core";
import { makeColumns, makeRows } from "./data";
import { Form } from "./form";
import { Grid } from "./grid";
import { ProcessScreen } from "./process";

export type Screen = "grid" | "form" | "process";

const ROW_COUNT = Number(process.env.QQQ_SPIKE_ROWS ?? 10_000);
const COL_COUNT = Number(process.env.QQQ_SPIKE_COLS ?? 40);

export function App({ initial = "grid" }: { initial?: Screen })
{
   const renderer = useRenderer();
   const { width, height } = useTerminalDimensions();
   const [screen, setScreen] = useState<Screen>(initial);
   const columns = useMemo(() => makeColumns(COL_COUNT), []);
   const rows = useMemo(() => makeRows(ROW_COUNT, columns), [columns]);

   useKeyboard((key: KeyEvent) =>
   {
      if (key.ctrl && key.name === "g") setScreen("grid");
      else if (key.ctrl && key.name === "f") setScreen("form");
      else if (key.ctrl && key.name === "p") setScreen("process");
      else if (key.ctrl && key.name === "q") renderer.destroy();
   });

   const title = `QQQ TUI spike · ${screen}   Ctrl+G grid  Ctrl+F form  Ctrl+P process  Ctrl+Q quit`;
   const bodyHeight = Math.max(3, height - 2);

   return (
      <box flexDirection="column" width={width} height={height}>
         <text fg="#ffffff" bg="#1b6587">{title.padEnd(width)}</text>
         <box flexGrow={1} flexShrink={1} minHeight={0} width={width}>
            {screen === "grid" && <Grid rows={rows} columns={columns} width={width} height={bodyHeight - 2} active />}
            {screen === "form" && <Form width={width} active />}
            {screen === "process" && <ProcessScreen width={width} active />}
         </box>
         <text fg="#66737f">{`${width}×${height} · ${rows.length.toLocaleString()} rows × ${columns.length} cols · pid ${process.pid}`.padEnd(width)}</text>
      </box>
   );
}
