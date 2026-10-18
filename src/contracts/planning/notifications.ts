import { z } from "zod"

export const NotificationPreferenceSchema = z.strictObject({
  eventType: z.string().trim().min(1).max(200),
  inApp: z.boolean(),
})
export const NotificationPreferencesUpdateSchema = z.strictObject({
  preferences: z.array(NotificationPreferenceSchema).max(200).readonly(),
})
export const InboxQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export const NotificationReadSchema = z.strictObject({ notificationId: z.string().uuid() })
