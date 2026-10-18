import { Bell } from "@phosphor-icons/react"
import type { z } from "zod"
import { Badge, EmptyState } from "../../components/primitives.tsx"
import type { InboxSchema } from "./planning-schemas.ts"

export function PlanningNotifications({
  inbox,
}: {
  readonly inbox: z.infer<typeof InboxSchema> | null
}) {
  return (
    <section className="section-stack">
      <h2>
        <Bell size={20} aria-hidden="true" /> Notifications
      </h2>
      {inbox?.notifications.length ? (
        <div className="data-list">
          {inbox.notifications.map((notification) => (
            <div className="record-row" key={notification.id}>
              <Badge tone={notification.readAt === null ? "info" : "neutral"}>
                {notification.readAt === null ? "Unread" : "Read"}
              </Badge>
              <strong>{notification.entityId}</strong>
              <span className="mono">#{notification.sequence}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title="Inbox clear" body="No visible notifications were returned." />
      )}
    </section>
  )
}
