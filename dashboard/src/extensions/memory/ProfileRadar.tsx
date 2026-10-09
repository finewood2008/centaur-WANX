import { useEffect, useState } from "react";
import { Alert, Button, Empty, Spin } from "antd";
import { useTranslation } from "react-i18next";
import memoryDashboardApi, {
  type AtomItem,
  type EntityItem,
} from "../../api/modules/memoryDashboard";
import { useServerTimezone } from "../../hooks/useServerTimezone";
import { formatServerIsoDateTime } from "../../utils/formatMessageTime";
import styles from "./ProfileRadar.module.less";

const groups = ["aboutMe", "currentFocus", "toldMe", "entities"] as const;
type Group = (typeof groups)[number];
interface Point {
  id: string;
  sourceId: string;
  entityId: string;
  group: Group;
  content: string;
  quote?: string;
  date?: string;
}
interface GroupData {
  group: Group;
  points: Point[];
  failed: boolean;
}
const LIMIT = 12; // Same summary window as the original ProfileOverview.

export function radarPosition(id: string, group: Group) {
  let hash = 2166136261;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  // Radius/angle only distribute content. No personality, certainty or alignment score.
  const angle =
    ((-135 + groups.indexOf(group) * 90 + ((hash % 1000) / 1000 - 0.5) * 58) *
      Math.PI) /
    180;
  const radius = 90 + ((hash >>> 10) % 100);
  return {
    x: 240 + Math.cos(angle) * radius,
    y: 240 + Math.sin(angle) * radius,
  };
}

export default function ProfileRadar({
  agentId,
  onViewAll,
  onPointSource,
  compact = false,
}: {
  agentId: string;
  onViewAll?: (entityId?: string) => void;
  onPointSource?: (source: { id: string; layer: "atom" | "page" }) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const timezone = useServerTimezone();
  const [data, setData] = useState<GroupData[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [focus, setFocus] = useState<Group | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setData([]);
    setSelected(null);
    void Promise.allSettled([
      memoryDashboardApi.terminalAboutMe(agentId, LIMIT),
      memoryDashboardApi.terminalCurrentFocus(agentId, LIMIT),
      memoryDashboardApi.terminalThingsYouToldMe(agentId, LIMIT),
      memoryDashboardApi.terminalEntities(agentId, LIMIT),
    ]).then((results) => {
      if (!current) return;
      setData(
        results.map((result, index) => ({
          group: groups[index],
          failed: result.status === "rejected",
          points:
            result.status === "fulfilled"
              ? result.value.items.map((item: AtomItem | EntityItem) => ({
                  id: `${groups[index]}:${item.id}`,
                  sourceId: item.id,
                  entityId: "entity_id" in item ? item.entity_id : item.id,
                  group: groups[index],
                  content:
                    "assertion" in item ? item.assertion : item.canonical_name,
                  quote:
                    "verbatim_quote" in item ? item.verbatim_quote : undefined,
                  date:
                    "occurred_at" in item
                      ? item.occurred_at || item.created_at
                      : item.created_at,
                }))
              : [],
        })),
      );
      setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [agentId, revision]);
  const points = data.flatMap((g) => g.points);
  const visible = points.filter((p) => !focus || p.group === focus);
  const point = points.find((p) => p.id === selected);
  return (
    <section className={styles.radar} aria-label={t("profileRadar.title")}>
      <header>
        <div>
          <h3>{t("profileRadar.title")}</h3>
          <p>{t("profileRadar.description")}</p>
        </div>
        <Button
          size="small"
          loading={loading}
          onClick={() => setRevision((r) => r + 1)}
        >
          {t("profileRadar.refresh")}
        </Button>
      </header>
      {data.some((g) => g.failed) && (
        <Alert
          type="warning"
          message={t("profileRadar.error", {
            groups: data
              .filter((g) => g.failed)
              .map((g) => t(`memory.terminal.${g.group}`))
              .join("、"),
          })}
        />
      )}
      {loading ? (
        <div className={styles.loading}>
          <Spin />
        </div>
      ) : (
        <>
          <div
            className={styles.groups}
            role="group"
            aria-label={t("profileRadar.groups")}
          >
            {data.map((g, i) => (
              <button
                key={g.group}
                aria-pressed={focus === g.group}
                onClick={() => {
                  setFocus(focus === g.group ? null : g.group);
                  setSelected(null);
                }}
              >
                <i style={{ background: `var(--profile-${i})` }} />
                {t(`memory.terminal.${g.group}`)}
                <small>{g.failed ? "—" : g.points.length}</small>
              </button>
            ))}
          </div>
          <div className={styles.body}>
            <div>
              <svg
                viewBox="0 0 480 480"
                role="group"
                aria-label={t("profileRadar.title")}
              >
                <title>{t("profileRadar.title")}</title>
                <desc>{t("profileRadar.meaning")}</desc>
                {[100, 155, 210].map((r) => (
                  <circle
                    key={r}
                    cx="240"
                    cy="240"
                    r={r}
                    className={styles.ring}
                  />
                ))}
                <path d="M240 30V450 M30 240H450" className={styles.axis} />
                <circle cx="240" cy="240" r="39" className={styles.center} />
                <text
                  x="240"
                  y="244"
                  textAnchor="middle"
                  className={styles.centerLabel}
                >
                  {t("memory.tabs.profile")}
                </text>
                {groups.map((g, i) => (
                  <text
                    key={g}
                    x={i === 0 || i === 3 ? 94 : 386}
                    y={i < 2 ? 72 : 420}
                    textAnchor="middle"
                    className={styles.groupLabel}
                  >
                    {t(`memory.terminal.${g}`)}
                  </text>
                ))}
                {points.map((p) => {
                  const xy = radarPosition(p.id, p.group);
                  return (
                    <g
                      key={p.id}
                      role="button"
                      tabIndex={0}
                      aria-label={p.content}
                      aria-pressed={selected === p.id}
                      className={`${styles.point} ${
                        focus && p.group !== focus ? styles.dimmed : ""
                      }`}
                      onClick={() => {
                        setSelected(p.id);
                        setFocus(null);
                      }}
                      onKeyDown={(e) => {
                        if (["Enter", " "].includes(e.key)) {
                          e.preventDefault();
                          setSelected(p.id);
                          setFocus(null);
                        }
                      }}
                    >
                      <title>{p.content}</title>
                      <circle cx={xy.x} cy={xy.y} r="13" fill="transparent" />
                      <circle
                        cx={xy.x}
                        cy={xy.y}
                        r={selected === p.id ? 7 : 5}
                        fill={`var(--profile-${groups.indexOf(p.group)})`}
                      />
                    </g>
                  );
                })}
              </svg>
              <p className={styles.note}>{t("profileRadar.meaning")}</p>
            </div>
            <div className={styles.details}>
              {point ? (
                <>
                  <Button
                    type="text"
                    size="small"
                    onClick={() => setSelected(null)}
                  >
                    {t("profileRadar.back")}
                  </Button>
                  <small>{t(`memory.terminal.${point.group}`)}</small>
                  <h4>{point.content}</h4>
                  {point.quote && <blockquote>{point.quote}</blockquote>}
                  {point.date && (
                    <small>
                      {formatServerIsoDateTime(point.date, timezone)}
                    </small>
                  )}
                  {(onViewAll || onPointSource) && (
                    <Button
                      onClick={() =>
                        onPointSource
                          ? onPointSource({
                              id: point.sourceId,
                              layer:
                                point.group === "entities" ? "page" : "atom",
                            })
                          : onViewAll?.(point.entityId)
                      }
                    >
                      {t("profileRadar.source")}
                    </Button>
                  )}
                  <p className={styles.note}>{t("profileRadar.sourceHint")}</p>
                </>
              ) : (
                <>
                  <p className={styles.hint}>{t("profileRadar.selectHint")}</p>
                  {!visible.length && (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={t("profileRadar.empty")}
                    />
                  )}
                  {!compact &&
                    visible.map((p) => (
                      <button
                        className={styles.row}
                        key={p.id}
                        onClick={() => setSelected(p.id)}
                      >
                        <small>{t(`memory.terminal.${p.group}`)}</small>
                        <span>{p.content}</span>
                      </button>
                    ))}
                </>
              )}
            </div>
          </div>
          <footer>{t("profileRadar.coverage", { limit: LIMIT })}</footer>
        </>
      )}
    </section>
  );
}
