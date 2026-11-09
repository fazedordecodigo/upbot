import { z } from "zod";

export const ProfileDefaults = z
  .object({
    private: z.boolean(),
    requireApproval: z.boolean(),
    delegationMode: z.enum(["now", "scheduled", "approval"]),
    toolMode: z.enum(["both", "browser", "terminal"]),
  })
  .strict();
export type ProfileDefaults = z.infer<typeof ProfileDefaults>;

export const Profile = z
  .object({
    name: z.string().max(40),
    about: z.string().max(600),
    onboardingCompletedAt: z.number().int().nonnegative().nullable(),
    defaults: ProfileDefaults,
    theme: z.enum(["dark", "light"]).nullable(),
    sidebarWidth: z.number().min(220).max(400).nullable(),
  })
  .strict();
export type Profile = z.infer<typeof Profile>;

export const ProfileUpdateParams = Profile.extend({
  defaults: ProfileDefaults.partial(),
}).partial();
export type ProfileUpdateParams = z.infer<typeof ProfileUpdateParams>;

export const MemoryKind = z.enum(["profile", "agent", "skill"]);
export const MemoryUsage = z.object({
  count: z.number().int().nonnegative(),
  kinds: z.array(MemoryKind),
});
export type MemoryUsage = z.infer<typeof MemoryUsage>;
export const MemoryUsageItem = z.object({ id: z.string(), text: z.string(), kind: MemoryKind });
export type MemoryUsageItem = z.infer<typeof MemoryUsageItem>;
export const MemoryUsageResult = MemoryUsage.extend({ items: z.array(MemoryUsageItem) });
export type MemoryUsageResult = z.infer<typeof MemoryUsageResult>;

const Empty = z.object({}).strict();
export const profileMethods = {
  "profile.get": { params: Empty, result: Profile },
  "profile.update": { params: ProfileUpdateParams, result: Profile },
  "profile.forget": { params: Empty, result: Profile },
  "onboarding.complete": { params: Empty, result: Profile },
  "onboarding.reset": { params: Empty, result: Profile },
  "memories.usage": {
    params: z.object({ turnId: z.string() }).strict(),
    result: MemoryUsageResult,
  },
} as const;
