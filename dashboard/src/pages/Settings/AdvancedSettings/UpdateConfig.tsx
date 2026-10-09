import { useTranslation } from "react-i18next";
import { Button, Alert } from "antd";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useUpdateStatus } from "../../../hooks/useUpdateStatus";
import { useServiceRestartContext } from "../../../context/ServiceRestartContext";
import { TabPanelHeader } from "./TabPanelHeader";
import styles from "./UpdateConfig.module.less";

const PROJECT_URL =
  "https://codeup.aliyun.com/667637d76d5f7b05cc5d9ed7/nexusaos/nexusaos-centuarai-omnia";

export default function UpdateConfig() {
  const { t } = useTranslation();
  const { status } = useUpdateStatus();
  const { isRestarting, requestRestart } = useServiceRestartContext();
  return (
    <section>
      <TabPanelHeader
        icon={<RefreshCw size={20} />}
        title={t("advancedSettings.update.title")}
        description={t("wanxRelease.description")}
      />
      <div className={styles.panel}>
        <h3>
          CentaurAI-WANX{" "}
          {status?.current_version ? `v${status.current_version}` : "—"}
        </h3>
        <Alert
          type="info"
          showIcon
          message={t("wanxRelease.title")}
          description={t("wanxRelease.manualHint")}
        />
        <p>{t("wanxRelease.dataHint")}</p>
        <Button
          href={PROJECT_URL}
          target="_blank"
          rel="noopener noreferrer"
          icon={<ExternalLink size={14} />}
        >
          {t("wanxRelease.project")}
        </Button>
        {(status?.desktop || status?.service_mode) && (
          <Button
            style={{ marginLeft: 12 }}
            loading={isRestarting}
            onClick={() => requestRestart()}
          >
            {t("advancedSettings.update.restartServiceBtn")}
          </Button>
        )}
      </div>
    </section>
  );
}
