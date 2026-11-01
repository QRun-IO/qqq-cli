// Deterministic sample data for the grid spike: N rows x M columns, seeded so runs are comparable.

export type Cell = string | number;
export type Row = Record<string, Cell>;
export type ColumnType = "string" | "number" | "date";
export interface Column
{
   name: string;
   label: string;
   width: number;
   type: ColumnType;
}

function mulberry32(seed: number): () => number
{
   let a = seed >>> 0;
   return () =>
   {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

const FIRST = ["Morgan", "Casey", "Riley", "Jordan", "Avery", "Quinn", "Taylor", "Drew", "Hayden", "Reese", "Skyler", "Parker"];
const LAST = ["Sample", "Kingsrook", "Maes", "Lopez", "Nguyen", "Okafor", "Schmidt", "Ivanova", "Haddad", "Brennan"];
const STATUS = ["Active", "Inactive", "Pending", "Archived"];
const STATES = ["Missouri", "Illinois", "Kansas", "Iowa", "Texas", "Ohio", "Colorado"];

export function makeColumns(count = 40): Column[]
{
   const fixed: Column[] = [
      { name: "id", label: "Id", width: 7, type: "number" },
      { name: "firstName", label: "First Name", width: 12, type: "string" },
      { name: "lastName", label: "Last Name", width: 12, type: "string" },
      { name: "email", label: "Email", width: 28, type: "string" },
      { name: "status", label: "Status", width: 10, type: "string" },
      { name: "homeState", label: "Home State", width: 11, type: "string" },
      { name: "createDate", label: "Create Date", width: 12, type: "date" },
      { name: "amount", label: "Amount", width: 12, type: "number" },
   ];
   const out = fixed.slice(0, count);
   for (let i = out.length; i < count; i++)
   {
      const numeric = i % 3 === 0;
      out.push({ name: `field${i}`, label: `Field ${i}`, width: numeric ? 9 : 14, type: numeric ? "number" : "string" });
   }
   return out;
}

export function makeRows(count = 10_000, columns: Column[] = makeColumns()): Row[]
{
   const rand = mulberry32(42);
   const rows: Row[] = new Array(count);
   for (let i = 0; i < count; i++)
   {
      const first = FIRST[Math.floor(rand() * FIRST.length)]!;
      const last = LAST[Math.floor(rand() * LAST.length)]!;
      const day = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 700) * 86_400_000);
      const row: Row = {
         id: i + 1,
         firstName: first,
         lastName: last,
         email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
         status: STATUS[Math.floor(rand() * STATUS.length)]!,
         homeState: STATES[Math.floor(rand() * STATES.length)]!,
         createDate: day.toISOString().slice(0, 10),
         amount: Math.round(rand() * 1_000_000) / 100,
      };
      for (const column of columns)
      {
         if (row[column.name] !== undefined)
         {
            continue;
         }
         row[column.name] = column.type === "number" ? Math.floor(rand() * 100_000) : `${column.label.toLowerCase()} ${Math.floor(rand() * 9_999)}`;
      }
      rows[i] = row;
   }
   return rows;
}

export type SortDirection = "asc" | "desc";

export function sortRows(rows: Row[], column: Column, direction: SortDirection): Row[]
{
   const sign = direction === "asc" ? 1 : -1;
   const copy = rows.slice();
   const key = column.name;
   copy.sort((a, b) =>
   {
      const x = a[key] as Cell;
      const y = b[key] as Cell;
      if (typeof x === "number" && typeof y === "number")
      {
         return (x - y) * sign;
      }
      return String(x).localeCompare(String(y)) * sign;
   });
   return copy;
}

export function formatCell(value: Cell | undefined, column: Column): string
{
   if (value === undefined || value === null)
   {
      return "";
   }
   if (column.type === "number" && typeof value === "number")
   {
      return column.name === "amount" ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value);
   }
   return String(value);
}
