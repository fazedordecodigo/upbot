import { useDaemon } from "../shell/daemon";
import { useDaemonQuery } from "./useDaemonQuery";

export function useShellProfile() {
  const { client, ready } = useDaemon();
  return useDaemonQuery(
    client,
    "profile.get",
    {},
    {
      enabled: ready,
      events: { "profile.changed": true },
    },
  );
}
