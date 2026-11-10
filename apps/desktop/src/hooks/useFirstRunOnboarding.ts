import { useEffect, useRef } from "react";
import { useDaemon } from "../shell/daemon";
import { useDaemonQuery } from "./useDaemonQuery";

export function useFirstRunOnboarding(open: () => void) {
  const { client, connected } = useDaemon();
  const { data } = useDaemonQuery(
    client,
    "profile.get",
    {},
    {
      enabled: connected,
      events: { "profile.changed": true },
    },
  );
  const shown = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (data.onboardingCompletedAt !== null) shown.current = false;
    else if (!shown.current) {
      shown.current = true;
      open();
    }
  }, [data, open]);
}
