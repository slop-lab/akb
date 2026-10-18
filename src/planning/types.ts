import type { FeatureCommandCall } from "../http/feature-command-router.ts"

export const PLANNING_ACTIONS = [
  "cycle.create",
  "cycle.update",
  "cycle.activate",
  "cycle.rollover",
  "milestone.create",
  "milestone.update",
  "module.create",
  "module.update",
  "work-planning.update",
  "project-update.publish",
  "template.create",
  "template.revise",
  "template.apply",
  "notification-preferences.create",
  "notification-preferences.update",
  "notification.read",
] as const

export type PlanningAction = (typeof PLANNING_ACTIONS)[number]
export type PlanningCommandCall = FeatureCommandCall<PlanningAction>
