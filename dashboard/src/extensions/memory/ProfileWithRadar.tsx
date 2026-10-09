import type { ComponentProps } from "react";
import ProfileOverview from "../../pages/Agent/Memory/ProfileOverview";
import ProfileRadar from "./ProfileRadar";

/** Add a read-only projection; the original profile and all its actions stay intact. */
export default function ProfileWithRadar(
  props: ComponentProps<typeof ProfileOverview>,
) {
  return (
    <>
      <ProfileRadar
        key={props.agentId}
        agentId={props.agentId}
        onViewAll={props.onViewAll}
      />
      <ProfileOverview {...props} />
    </>
  );
}
