// A form with one editor per QQQ field type, keyboard-only, with local validation.

import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import type { KeyEvent, TextareaRenderable } from "@opentui/core";

export type FieldType = "STRING" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "DATE_TIME" | "TIME" | "PASSWORD" | "TEXT" | "PVS" | "BLOB";

export interface Field
{
   name: string;
   label: string;
   type: FieldType;
   required?: boolean;
   options?: string[];
}

export const SAMPLE_FIELDS: Field[] = [
   { name: "firstName", label: "First Name", type: "STRING", required: true },
   { name: "age", label: "Age", type: "INTEGER" },
   { name: "balance", label: "Balance", type: "DECIMAL" },
   { name: "isActive", label: "Active", type: "BOOLEAN" },
   { name: "birthDate", label: "Birth Date", type: "DATE", required: true },
   { name: "lastLogin", label: "Last Login", type: "DATE_TIME" },
   { name: "wakeTime", label: "Wake Time", type: "TIME" },
   { name: "secret", label: "Password", type: "PASSWORD" },
   { name: "homeState", label: "Home State", type: "PVS", options: ["Missouri", "Mississippi", "Illinois", "Iowa", "Idaho", "Indiana", "Kansas", "Kentucky", "Texas", "Ohio"] },
   { name: "notes", label: "Notes", type: "TEXT" },
   { name: "avatar", label: "Avatar file", type: "BLOB" },
];

export type Values = Record<string, string | boolean>;

const COLORS = { label: "#d5dce5", dim: "#66737f", focus: "#7cc2e8", error: "#ff9088", ok: "#8bd49b", fieldBg: "#161d26", focusBg: "#1f3646" };

export function validate(fields: Field[], values: Values): Record<string, string>
{
   const errors: Record<string, string> = {};
   for (const f of fields)
   {
      const v = values[f.name];
      const s = typeof v === "string" ? v.trim() : "";
      if (f.required && f.type !== "BOOLEAN" && s === "")
      {
         errors[f.name] = "required";
         continue;
      }
      if (s === "")
      {
         continue;
      }
      switch (f.type)
      {
         case "INTEGER": if (!/^-?\d+$/.test(s)) errors[f.name] = "must be a whole number"; break;
         case "DECIMAL": if (!/^-?\d+(\.\d+)?$/.test(s)) errors[f.name] = "must be a number"; break;
         case "DATE": if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) errors[f.name] = "use YYYY-MM-DD"; break;
         case "DATE_TIME": if (Number.isNaN(Date.parse(s))) errors[f.name] = "use YYYY-MM-DDTHH:MM"; break;
         case "TIME": if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) errors[f.name] = "use HH:MM (24h)"; break;
         case "PVS": if (!f.options?.includes(s)) errors[f.name] = "pick a value from the list"; break;
         default: break;
      }
   }
   return errors;
}

export interface FormProps
{
   fields?: Field[];
   width: number;
   active: boolean;
   onSave?: (values: Values) => void;
}

export function Form({ fields = SAMPLE_FIELDS, width, active, onSave }: FormProps)
{
   const [values, setValues] = useState<Values>(() => Object.fromEntries(fields.map((f) => [f.name, f.type === "BOOLEAN" ? false : ""])));
   const [focus, setFocus] = useState(0);
   const [errors, setErrors] = useState<Record<string, string>>({});
   const [pvsIndex, setPvsIndex] = useState(0);
   const [saved, setSaved] = useState<string | null>(null);
   const textareas = useRef<Record<string, TextareaRenderable | null>>({});

   const field = fields[focus]!;

   function set(name: string, value: string | boolean)
   {
      setValues((v) => ({ ...v, [name]: value }));
      setSaved(null);
   }

   function pvsMatches(f: Field): string[]
   {
      const q = String(values[f.name] ?? "").toLowerCase();
      return (f.options ?? []).filter((o) => o.toLowerCase().includes(q));
   }

   useKeyboard((key: KeyEvent) =>
   {
      if (!active)
      {
         return;
      }
      if (key.name === "tab")
      {
         setFocus((i) => (i + (key.shift ? fields.length - 1 : 1)) % fields.length);
         setPvsIndex(0);
         return;
      }
      if (key.ctrl && key.name === "s")
      {
         const found = validate(fields, values);
         setErrors(found);
         if (Object.keys(found).length === 0)
         {
            setSaved(JSON.stringify(values));
            onSave?.(values);
         }
         return;
      }
      if (field.type === "BOOLEAN" && (key.name === "space" || key.name === "return" || key.sequence === " "))
      {
         set(field.name, !values[field.name]);
         return;
      }
      if (field.type === "PASSWORD")
      {
         const current = String(values[field.name] ?? "");
         if (key.name === "backspace")
         {
            set(field.name, current.slice(0, -1));
         }
         else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= " ")
         {
            set(field.name, current + key.sequence);
         }
         return;
      }
      if (field.type === "PVS")
      {
         const matches = pvsMatches(field);
         if (key.name === "down")
         {
            setPvsIndex((i) => Math.min(matches.length - 1, i + 1));
         }
         else if (key.name === "up")
         {
            setPvsIndex((i) => Math.max(0, i - 1));
         }
         else if (key.name === "return" && matches[pvsIndex])
         {
            set(field.name, matches[pvsIndex]!);
         }
      }
   });

   const labelWidth = 14;
   const controlWidth = Math.max(20, Math.min(44, width - labelWidth - 4));

   return (
      <box flexDirection="column" width={width}>
         {fields.map((f, i) =>
         {
            const focused = i === focus;
            const error = errors[f.name];
            const value = values[f.name];
            const label = (f.label + (f.required ? " *" : "")).padEnd(labelWidth);
            const rowColor = focused ? COLORS.focus : COLORS.label;
            let control;
            switch (f.type)
            {
               case "BOOLEAN":
                  control = <text fg={rowColor}>{value ? "[x] yes" : "[ ] no"}{focused ? "   (space toggles)" : ""}</text>;
                  break;
               case "PASSWORD":
                  control = (
                     <box width={controlWidth} backgroundColor={focused ? COLORS.focusBg : COLORS.fieldBg}>
                        <text fg={COLORS.label}>{"•".repeat(String(value ?? "").length)}{focused ? "▏" : ""}</text>
                     </box>
                  );
                  break;
               case "TEXT":
                  control = (
                     <box width={controlWidth} height={4} border borderColor={focused ? COLORS.focus : COLORS.dim}>
                        <textarea ref={(r: TextareaRenderable | null) => { textareas.current[f.name] = r; }} focused={active && focused} initialValue="" placeholder="multi-line, Enter adds a line" onContentChange={() => set(f.name, textareas.current[f.name]?.plainText ?? "")} />
                     </box>
                  );
                  break;
               case "PVS": {
                  const matches = pvsMatches(f);
                  control = (
                     <box flexDirection="column" width={controlWidth}>
                        <box backgroundColor={focused ? COLORS.focusBg : COLORS.fieldBg}>
                           <input focused={active && focused} value={String(value ?? "")} placeholder="type to narrow" onInput={(v: string) => { set(f.name, v); setPvsIndex(0); }} />
                        </box>
                        {focused && matches.slice(0, 4).map((m, mi) => (
                           <text key={m} fg={mi === pvsIndex ? COLORS.focus : COLORS.dim}>{mi === pvsIndex ? " ▶ " : "   "}{m}</text>
                        ))}
                        {focused && <text fg={COLORS.dim}>{`   ${matches.length} of ${f.options?.length ?? 0} · ↑↓ then Enter`}</text>}
                     </box>
                  );
                  break;
               }
               default:
                  control = (
                     <box width={controlWidth} backgroundColor={focused ? COLORS.focusBg : COLORS.fieldBg}>
                        <input focused={active && focused} value={String(value ?? "")} placeholder={placeholderFor(f.type)} onInput={(v: string) => set(f.name, v)} />
                     </box>
                  );
            }
            return (
               <box key={f.name} flexDirection="row" gap={1}>
                  <text fg={rowColor}>{(focused ? "▶ " : "  ") + label}</text>
                  {control}
                  {error && <text fg={COLORS.error}>{"! " + error}</text>}
               </box>
            );
         })}
         <text fg={COLORS.dim}>{`field ${focus + 1}/${fields.length} · Tab / Shift+Tab move · Ctrl+S save`}</text>
         {saved && <text fg={COLORS.ok}>{"saved: " + saved}</text>}
      </box>
   );
}

function placeholderFor(type: FieldType): string
{
   switch (type)
   {
      case "INTEGER": return "whole number";
      case "DECIMAL": return "0.00";
      case "DATE": return "YYYY-MM-DD";
      case "DATE_TIME": return "YYYY-MM-DDTHH:MM";
      case "TIME": return "HH:MM";
      case "BLOB": return "/path/to/file";
      default: return "";
   }
}
