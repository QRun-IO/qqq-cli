import { expect, test } from "bun:test";
import { parseCriterion } from "../src/shell/shell";
import { columnsFor } from "../src/shell/table-screen";
import { flatten } from "../src/shell/sidebar";

test("parseCriterion handles values, lists and numbers", () =>
{
   expect(parseCriterion("lastName STARTS_WITH S")).toEqual({ fieldName: "lastName", operator: "STARTS_WITH", values: ["S"] });
   expect(parseCriterion("id BETWEEN 10,20")).toEqual({ fieldName: "id", operator: "BETWEEN", values: [10, 20] });
   expect(parseCriterion("email IS_BLANK")).toEqual({ fieldName: "email", operator: "IS_BLANK", values: [] });
   expect(parseCriterion("garbage")).toBeNull();
});

test("columnsFor puts the primary key first, then sections by tier, then the rest", () =>
{
   const cols = columnsFor({
      name: "t", label: "T", primaryKeyField: "id",
      fields: { id: { name: "id", label: "Id", type: "INTEGER" }, b: { name: "b", label: "B", type: "STRING" }, a: { name: "a", label: "A", type: "STRING" }, z: { name: "z", label: "Z", type: "DATE" }, p: { name: "p", label: "Person", type: "INTEGER", possibleValueSourceName: "person" } },
      sections: [{ name: "s2", label: "S2", tier: "T2", fieldNames: ["b"] }, { name: "s1", label: "S1", tier: "T1", fieldNames: ["id", "a"] }],
   });
   expect(cols.map((c) => c.name)).toEqual(["id", "a", "b", "z", "p"]);
   expect(cols.find((c) => c.name === "p")!.width).toBe(18);
});

test("flatten only descends into expanded nodes", () =>
{
   const tree = [{ type: "APP", name: "x", label: "X", children: [{ type: "TABLE", name: "t", label: "T" }] }, { type: "APP", name: "y", label: "Y", children: [{ type: "TABLE", name: "u", label: "U" }] }];
   expect(flatten(tree, new Set(["/x"])).map((f) => f.node.name)).toEqual(["x", "t", "y"]);
});
