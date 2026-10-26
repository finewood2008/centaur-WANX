import { app } from "electron";
import path from "node:path";
if (!process.argv.some(arg=>arg.startsWith("--user-data-dir="))) app.setPath("userData", path.join(app.getPath("appData"), "wanx-studio-team-client"));
import { launchInstalledApplication } from "../applications/runtime.mjs";

// A packaged executable always loads its own package.main. Dispatch hosted
// applications before the Host claims its single-instance lock or starts P2P.
const application = process.argv.find(value => value.startsWith("--wanx-application="));
if (application) {
  try {
    await launchInstalledApplication({
      app,
      applicationRoot: process.env.WANX_HOST_APPLICATION_ROOT || path.join(app.getPath("userData"), "applications"),
      installPath: application.slice("--wanx-application=".length),
    });
  } catch {
    process.send?.({ type: "wanx:application-failed", launchId: process.env.WANX_HOST_LAUNCH_ID }, () => {});
    app.exit(1);
  }
} else {
  await import("./main.mjs");
}
