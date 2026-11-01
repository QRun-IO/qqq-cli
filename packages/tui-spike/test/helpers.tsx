import { act } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";

/** Fire keyboard input inside React act(), let the stdin data event settle, then paint one frame. */
export async function press(setup: TestRendererSetup, fire: () => void | Promise<void>): Promise<string>
{
   await act(async () =>
   {
      await fire();
      await new Promise((resolve) => setTimeout(resolve, 5));
   });
   await setup.renderOnce();
   return setup.captureCharFrame();
}
