import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { KeyCodes } from "@opentui/core/testing";
import { makeColumns, makeRows } from "../src/data";
import { Grid, visibleColumns } from "../src/grid";
import { press } from "./helpers";

test("visibleColumns fits the width", () =>
{
   const columns = makeColumns(40);
   const cols = visibleColumns(columns, 0, 60);
   const used = cols.reduce((n, c) => n + c.width + 1, 0);
   expect(used).toBeLessThanOrEqual(61);
   expect(cols.length).toBeGreaterThan(1);
});

test("grid renders the window and moves the cursor", async () =>
{
   const columns = makeColumns(8);
   const rows = makeRows(50, columns);
   const setup = await testRender(<Grid rows={rows} columns={columns} width={80} height={5} active />, { width: 80, height: 10 });
   try
   {
      await setup.renderOnce();
      const first = setup.captureCharFrame();
      expect(first).toContain("First Name");
      expect(first).toContain("row 1 of 50");
      const second = await press(setup, () => setup.mockInput.pressArrow("down"));
      expect(second).toContain("row 2 of 50");
      const last = await press(setup, () => setup.mockInput.pressKey(KeyCodes.END));
      expect(last).toContain("row 50 of 50");
      const sorted = await press(setup, () => setup.mockInput.pressKey("s"));
      expect(sorted).toContain("sort Id asc");
      expect(sorted).toContain("row 1 of 50");
      const paged = await press(setup, () => setup.mockInput.pressKey("\x1b[6~"));
      expect(paged).toContain("row 6 of 50");
   }
   finally
   {
      setup.renderer.destroy();
   }
});
