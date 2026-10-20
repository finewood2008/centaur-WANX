// Compile the real NSIS hooks without an Electron payload or a Windows host.
// This checks syntax/assets for install and uninstall; it is NOT install QA.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, "release/installer-ui-check"));
await mkdir(output, { recursive: true });
const compiler = await getMakeNsisPath();
const nsisPath = value => value.replaceAll("\\", "/").replaceAll("$", "$$").replaceAll('"', '$\\"');
for (const uninstall of [false, true]) {
  const name = uninstall ? "uninstall" : "install";
  const source = `Unicode true
Name "WANX installer UI compile check"
OutFile "${nsisPath(path.join(output, `${name}-compile-check.exe`))}"
RequestExecutionLevel user
ShowInstDetails nevershow
!define PROJECT_DIR "${nsisPath(root)}"
!define isUpdated '\"\" == \"updated\"'
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${nsisPath(path.join(root, "resources/installer/header.bmp"))}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${nsisPath(path.join(root, "resources/installer/sidebar.bmp"))}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${nsisPath(path.join(root, "resources/installer/sidebar.bmp"))}"
Var installMode
${uninstall ? "!define BUILD_UNINSTALLER" : ""}
!include "${nsisPath(path.join(root, "shell/installer.nsh"))}"
!include MUI2.nsh
${uninstall ? `
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
` : `
!insertmacro customWelcomePage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
`}
!insertmacro MUI_LANGUAGE "SimpChinese"
${uninstall ? "" : "!insertmacro customHeader"}
Function .onInit
  StrCpy $installMode "current"
  StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\WanxInstallerCompileCheck"
  ${uninstall ? "" : "!insertmacro customInit"}
FunctionEnd
Section "${uninstall ? "Uninstall" : "Install"}"
  ${uninstall ? "" : "!insertmacro customInstall"}
SectionEnd
${uninstall ? `Section "Compile carrier"
  WriteUninstaller "$TEMP\\WANX-uninstall-compile-check.exe"
SectionEnd` : ""}
`;
  const script = path.join(output, `${name}-compile-check.nsi`);
  await writeFile(script, source);
  const log = execFileSync(compiler.path, ["-V3", script], {
    cwd: root, env: { ...process.env, ...compiler.env }, encoding: "utf8",
  });
  await writeFile(path.join(output, `${name}-compile-check.log`), log);
  // In particular, fail on forward variable references that NSIS accepts as
  // literal strings. Unreferenced fixture functions are harmless warnings.
  if (/unknown (variable|constant)|invalid opcode/i.test(log)) throw new Error(log);
  console.log(`${name}: NSIS hooks compiled`);
}
console.log(`Compile fixtures only (not a client installer): ${output}`);
