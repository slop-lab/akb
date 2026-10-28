export class LatestRequest {
  #generation = 0

  start(): () => boolean {
    const generation = ++this.#generation
    return () => generation === this.#generation
  }

  invalidate(): void {
    this.#generation += 1
  }
}
