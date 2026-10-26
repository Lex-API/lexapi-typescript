// Smoke test of the BUILT ESM bundle (dist/index.js).
import * as sdk from "../dist/index.js";
import { runSmoke } from "./smoke-lib.mjs";

await runSmoke(sdk, "esm");
