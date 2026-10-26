// Smoke test of the BUILT CommonJS bundle (dist/index.cjs) via require().
const sdk = require("../dist/index.cjs");

import("./smoke-lib.mjs")
  .then(({ runSmoke }) => runSmoke(sdk, "cjs"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
