// Compile the spike into standalone executables for the targets we care about.
export {};

const targets: { target: string; outfile: string; libc?: "glibc" | "musl" }[] = [
   { target: "bun-darwin-arm64", outfile: "dist/qqq-tui-spike-darwin-arm64" },
   { target: "bun-linux-x64", outfile: "dist/qqq-tui-spike-linux-x64", libc: "glibc" },
   { target: "bun-windows-x64", outfile: "dist/qqq-tui-spike-windows-x64.exe" },
];

const only = process.argv[2];
for (const t of targets)
{
   if (only && !t.target.includes(only))
   {
      continue;
   }
   const started = performance.now();
   const result = await Bun.build({
      entrypoints: ["./src/main.tsx"],
      compile: { target: t.target as any, outfile: t.outfile },
      define: t.libc ? { "process.env.OPENTUI_LIBC": JSON.stringify(t.libc) } : {},
   });
   const ms = Math.round(performance.now() - started);
   if (!result.success)
   {
      console.error(`${t.target}: FAILED in ${ms} ms`);
      for (const log of result.logs) console.error(String(log));
      process.exitCode = 1;
      continue;
   }
   const size = Bun.file(t.outfile).size;
   console.log(`${t.target}: ${t.outfile} ${(size / 1_048_576).toFixed(1)} MB in ${ms} ms`);
}
