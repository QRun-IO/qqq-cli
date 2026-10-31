import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Form, SAMPLE_FIELDS, validate } from "../src/form";
import { press } from "./helpers";

test("validate reports type errors and required fields", () =>
{
   const errors = validate(SAMPLE_FIELDS, { firstName: "", age: "x", balance: "1.5", isActive: false, birthDate: "2020-13-01", lastLogin: "", wakeTime: "25:00", secret: "", homeState: "Nowhere", notes: "", avatar: "" });
   expect(errors.firstName).toBe("required");
   expect(errors.age).toBe("must be a whole number");
   expect(errors.balance).toBeUndefined();
   expect(errors.birthDate).toBe("use YYYY-MM-DD");
   expect(errors.wakeTime).toBe("use HH:MM (24h)");
   expect(errors.homeState).toBe("pick a value from the list");
});

test("form accepts typing and tab moves focus", async () =>
{
   const setup = await testRender(<Form width={90} active />, { width: 90, height: 30 });
   try
   {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("field 1/11");
      const typed = await press(setup, () => setup.mockInput.typeText("Morgan"));
      expect(typed).toContain("Morgan");
      const moved = await press(setup, () => setup.mockInput.pressTab());
      expect(moved).toContain("field 2/11");
      const back = await press(setup, () => setup.mockInput.pressTab({ shift: true }));
      expect(back).toContain("field 1/11");
      const saved = await press(setup, () => setup.mockInput.pressKey("s", { ctrl: true }));
      expect(saved).toContain("! required");
   }
   finally
   {
      setup.renderer.destroy();
   }
});
