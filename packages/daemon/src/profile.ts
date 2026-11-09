import type { Database } from "bun:sqlite";
import { type Profile, ProfileUpdateParams } from "@boto/protocol";
import { getProfileDefaults, getSetting, profileSettings, setSetting } from "./db/settings";
import type { MemoryStore } from "./memories";
import type { Broadcast } from "./runtime/agent-runtime";

export { getProfileDefaults } from "./db/settings";

export class ProfileService {
  constructor(
    private db: Database,
    private memories: MemoryStore,
    private broadcast: Broadcast,
  ) {}

  get(): Profile {
    return {
      name: getSetting(this.db, "profile.name", profileSettings["profile.name"], ""),
      about: this.memories.userProfile()?.text ?? "",
      defaults: getProfileDefaults(this.db),
      onboardingCompletedAt: getSetting(
        this.db,
        "onboarding.completed_at",
        profileSettings["onboarding.completed_at"],
        null,
      ),
      theme: getSetting(this.db, "ui.theme", profileSettings["ui.theme"], null),
      sidebarWidth: getSetting(
        this.db,
        "ui.sidebar_width",
        profileSettings["ui.sidebar_width"],
        null,
      ),
    };
  }

  update(input: ProfileUpdateParams): Profile {
    const p = ProfileUpdateParams.parse(input);
    const profile = this.db.transaction(() => {
      if (p.name !== undefined) setSetting(this.db, "profile.name", p.name);
      if (p.about !== undefined) this.memories.setUserProfile(p.about);
      if (p.defaults !== undefined) {
        setSetting(this.db, "profile.defaults", { ...getProfileDefaults(this.db), ...p.defaults });
      }
      if (p.onboardingCompletedAt !== undefined)
        setSetting(this.db, "onboarding.completed_at", p.onboardingCompletedAt);
      if (p.theme !== undefined) setSetting(this.db, "ui.theme", p.theme);
      if (p.sidebarWidth !== undefined) setSetting(this.db, "ui.sidebar_width", p.sidebarWidth);
      return this.get();
    })();
    this.broadcast("profile.changed", profile);
    return profile;
  }

  forget(): Profile {
    return this.update({ name: "", about: "" });
  }

  complete(): Profile {
    return this.update({ onboardingCompletedAt: this.get().onboardingCompletedAt ?? Date.now() });
  }

  reset(): Profile {
    return this.update({ onboardingCompletedAt: null });
  }
}
