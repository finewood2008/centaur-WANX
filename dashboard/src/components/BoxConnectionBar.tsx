import { isWanxDesktopClient } from "../utils/desktopClient";
import { DesktopClientBar } from "../pages/DesktopClient";

export default function BoxConnectionBar() {
  return isWanxDesktopClient() ? <DesktopClientBar /> : null;
}
