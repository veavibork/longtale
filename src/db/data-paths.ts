import path from 'node:path'

/** LONGTALE_DATA_DIR overrides the data folder, e.g. for tests and experiments. */
export function dataDir(): string {
  return path.resolve(process.cwd(), process.env.LONGTALE_DATA_DIR ?? 'data')
}

export function storiesDir(): string {
  return path.join(dataDir(), 'stories')
}

export function globalDbPath(): string {
  return path.join(dataDir(), 'global.sqlite')
}

export function storyDbPath(storyId: string): string {
  return path.join(storiesDir(), `${storyId}.sqlite`)
}
