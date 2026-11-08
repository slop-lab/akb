import { z } from "zod"

export const CreateProjectNotebookSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
})

export type CreateProjectNotebook = z.infer<typeof CreateProjectNotebookSchema>
