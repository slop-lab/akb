import type {
  KnowledgeCandidate,
  ProposalSource,
} from "../../../../../src/contracts/knowledge/proposals.ts"
import { Fragment } from "react"

export function CandidateDetails({ candidate }: { readonly candidate: KnowledgeCandidate }) {
  return (
    <details className="section-stack">
      <summary>All candidate fields</summary>
      <dl className="metadata-grid">
        {Object.entries(candidate).map(([field, value]) => (
          <Fragment key={field}>
            <dt>{field}</dt>
            <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}

export function candidateText(candidate: KnowledgeCandidate): string {
  switch (candidate.type) {
    case "claim":
      return candidate.statement
    case "decision":
      return candidate.decision
    case "evidence":
      return candidate.observation
    case "question":
      return candidate.question
    case "experiment":
      return candidate.hypothesis
    default:
      return assertNever(candidate)
  }
}

export function SourceList({ sources }: { readonly sources: readonly ProposalSource[] }) {
  if (sources.length === 0) return null
  return (
    <section className="section-stack">
      <h3>Sources</h3>
      <ul className="source-list">
        {sources.map((source) => (
          <SourceItem source={source} key={sourceKey(source)} />
        ))}
      </ul>
    </section>
  )
}

function sourceKey(source: ProposalSource): string {
  switch (source.kind) {
    case "external":
      return `${source.kind}:${source.serviceInstanceId}:${source.resourceKind}:${source.resourceId}:${source.version.kind}:${source.version.value}:${source.role}`
    case "entity":
      return `${source.kind}:${source.entityId}:${source.revision}:${source.role}`
    case "runtime_artifact":
      return `${source.kind}:${source.artifactId}:${source.role}`
    default:
      return assertNever(source)
  }
}

function SourceItem({ source }: { readonly source: ProposalSource }) {
  switch (source.kind) {
    case "external":
      return (
        <li>
          <a href={source.permalink} target="_blank" rel="noreferrer">
            {source.serviceInstanceId} · {source.resourceKind} · {source.resourceId} ·{" "}
            {source.version.kind} {source.version.value}
          </a>
          {source.excerpt === undefined ? null : <blockquote>{source.excerpt}</blockquote>}
        </li>
      )
    case "entity":
      return (
        <li>
          {source.entityId} · rev {source.revision}
        </li>
      )
    case "runtime_artifact":
      return <li>{source.artifactId}</li>
    default:
      return assertNever(source)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported knowledge detail: ${JSON.stringify(value)}`)
}
