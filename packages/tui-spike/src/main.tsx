import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app";
import { writeReport } from "./perf";

const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: false, gatherStats: true, targetFps: 60 });
const reportPath = process.env.QQQ_SPIKE_REPORT ?? "spike-perf.json";

renderer.on("destroy", () =>
{
   void writeReport(reportPath, { platform: process.platform, arch: process.arch, bun: Bun.version, term: process.env.TERM ?? "", columns: process.stdout.columns, rows: process.stdout.rows });
});

createRoot(renderer).render(<App />);
