// Tiny latency collector: key press -> painted frame, written out at exit as JSON.

export interface Sample
{
   name: string;
   ms: number;
}

const samples: Sample[] = [];

export function record(name: string, ms: number): void
{
   samples.push({ name, ms });
}

export interface Summary
{
   name: string;
   count: number;
   avg: number;
   p95: number;
   max: number;
}

export function summarize(): Summary[]
{
   const byName = new Map<string, number[]>();
   for (const s of samples)
   {
      const list = byName.get(s.name) ?? [];
      list.push(s.ms);
      byName.set(s.name, list);
   }
   const out: Summary[] = [];
   for (const [name, list] of byName)
   {
      const sorted = list.slice().sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
      out.push({ name, count: sorted.length, avg: round(avg), p95: round(p95), max: round(sorted[sorted.length - 1]!) });
   }
   return out;
}

export function lastOf(name: string): number | undefined
{
   for (let i = samples.length - 1; i >= 0; i--)
   {
      if (samples[i]!.name === name)
      {
         return samples[i]!.ms;
      }
   }
   return undefined;
}

function round(n: number): number
{
   return Math.round(n * 100) / 100;
}

export async function writeReport(path: string, extra: Record<string, unknown> = {}): Promise<void>
{
   const report = { generatedAt: new Date().toISOString(), ...extra, summary: summarize(), sampleCount: samples.length };
   await Bun.write(path, JSON.stringify(report, null, 2) + "\n");
}
