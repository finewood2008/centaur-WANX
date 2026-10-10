import { useState } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import { useUpdateStatus } from "../../hooks/useUpdateStatus";
import styles from "./index.module.less";

const BRAND_NAME = "半人马AI-万象";
const BRAND_ENGLISH = "CentaurAI-WANX";

export default function WorkbenchBrand({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const { status } = useUpdateStatus();

  return (
    <>
      <button
        type="button"
        className={`${styles.trigger} ${collapsed ? styles.collapsed : ""}`}
        aria-label={t("workbenchAbout.title")}
        aria-haspopup="dialog"
        title={t("workbenchAbout.title")}
        onClick={() => setOpen(true)}
      >
        <img src="/centaurai-mark.png" alt="" className={styles.mark} />
        {!collapsed && (
          <span className={styles.names}>
            <strong>{BRAND_NAME}</strong>
            <small aria-label={BRAND_ENGLISH}>
              {[...BRAND_ENGLISH].map((letter, index) => (
                <span key={index} aria-hidden="true">
                  {letter}
                </span>
              ))}
            </small>
          </span>
        )}
      </button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        centered
        width={440}
        className={styles.dialog}
        styles={{ mask: { backdropFilter: "blur(3px)" } }}
        title={
          <div className={styles.heading}>
            <img src="/centaurai-mark.png" alt="" />
            <div>
              <span className={styles.title}>{BRAND_NAME}</span>
              <p className={styles.english}>{BRAND_ENGLISH}</p>
            </div>
          </div>
        }
      >
        <p className={styles.purpose}>{t("workbenchAbout.purpose")}</p>
        <p className={styles.description}>{t("workbenchAbout.description")}</p>
        <dl className={styles.version}>
          <dt>{t("workbenchAbout.version")}</dt>
          <dd>
            {status?.current_version ? `v${status.current_version}` : "—"}
          </dd>
        </dl>
        <footer className={styles.footer}>
          {t("workbenchAbout.producer")}
        </footer>
      </Modal>
    </>
  );
}
