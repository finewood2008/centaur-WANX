import { useTranslation } from "react-i18next";
import PageShell, { pageShellStyles } from "../../../layouts/PageShell";
import { useAgent } from "../../../context/AgentContext";
import { useIsMobile } from "../../../hooks/useIsMobile";
import MemoryPanel from "./MemoryPanel";

export default function MemoryPage() {
  const { t } = useTranslation();
  const { activeAgentId } = useAgent();
  const isMobile = useIsMobile();
  return (
    <PageShell
      title={t("nav.memory")}
      subtitle={t("profileRadar.memoryDescription")}
      agentScoped
      fill={!isMobile}
    >
      {isMobile ? (
        <MemoryPanel agentId={activeAgentId} fill={false} />
      ) : (
        <div className={pageShellStyles.fillChild}>
          <MemoryPanel agentId={activeAgentId} fill />
        </div>
      )}
    </PageShell>
  );
}
