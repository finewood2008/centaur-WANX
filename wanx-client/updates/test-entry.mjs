import { app } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { testPackageIdentity, TEST_PACKAGE_NAME, TEST_PRODUCT_NAME } from "./test-build.mjs";

const identity = testPackageIdentity(JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")));
if (!app.isPackaged || !identity) throw new Error("UPDATE_TEST_CONFIGURATION_INVALID");
app.setName(TEST_PRODUCT_NAME);
const userData = path.join(app.getPath("appData"), TEST_PACKAGE_NAME, identity.testRunId);
mkdirSync(userData, { recursive: true, mode: 0o700 });
app.setPath("userData", userData);
await import("../shell/entry.mjs");
