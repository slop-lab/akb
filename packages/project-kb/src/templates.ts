import type { ContentDocument, TemplateId } from "./contracts.ts"

export const PROJECT_KB_TEMPLATES = [
  {
    id: "blank",
    name: "Blank note",
    description: "A small space for anything worth remembering.",
    sections: ["Notes"],
  },
  {
    id: "project-overview",
    name: "Project overview",
    description: "Direction, constraints, references, and the next useful step.",
    sections: [
      "Intent",
      "Audience and experience",
      "Constraints",
      "References and working files",
      "Next steps",
    ],
  },
  {
    id: "music-brief",
    name: "Composition brief",
    description: "A song, cue, or sound experiment without losing its creative intent.",
    sections: [
      "Musical intent",
      "Tempo, key, and meter",
      "Structure and instrumentation",
      "Sound and mix direction",
      "References and DAW files",
      "Listening notes and next pass",
    ],
  },
  {
    id: "map-brief",
    name: "Game map brief",
    description: "Capture player experience, routes, encounters, and playtest learning.",
    sections: [
      "Player experience",
      "Layout and critical path",
      "Scale and traversal rules",
      "Encounters and pacing",
      "Visual language and engine files",
      "Playtest observations and next pass",
    ],
  },
  {
    id: "experiment-log",
    name: "Experiment log",
    description: "Keep the question, what you tried, and what changed.",
    sections: [
      "Question",
      "Setup and references",
      "What I tried",
      "Observations",
      "What to keep or change",
    ],
  },
  {
    id: "decision",
    name: "Creative decision",
    description: "Record a choice and its tradeoffs without turning it into policy.",
    sections: [
      "Decision",
      "Context",
      "Alternatives",
      "Why this choice",
      "Consequences and revisit trigger",
    ],
  },
] as const

export function documentFromTemplate(id: TemplateId): ContentDocument {
  const template = PROJECT_KB_TEMPLATES.find((item) => item.id === id)
  if (template === undefined) throw new RangeError("Unknown project knowledge template")
  return {
    version: 1,
    blocks: template.sections.flatMap((heading, index) => [
      { id: `heading-${index}`, type: "heading", level: 2, text: heading, children: [] },
      { id: `body-${index}`, type: "paragraph", text: "", children: [] },
    ]),
  }
}
