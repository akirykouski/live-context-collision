import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { MemoryFact } from "./types";
import { getValkey, hasValkey } from "./valkey";

/**
 * Store for facts the Memory Curator wrote back during a live meeting.
 *
 * Persistence mirrors the service-action runtime store: Valkey when configured
 * (so the web process and the worker share one graph), a JSON file otherwise.
 * A small in-process cache keeps {@link learnedFactsCache} synchronous so the
 * collision hot path can retrieve over learned facts without an await.
 */

const LEARNED_KEY = "workgraph:learned-facts";
const RUNTIME_PATH =
  process.env.LEARNED_FACTS_PATH ||
  path.join(process.cwd(), "src", "data", "learned-facts.runtime.json");
const HYDRATE_TTL_MS = Number(process.env.LEARNED_FACTS_TTL_MS ?? 3000);

interface LearnedFactsFile {
  facts: MemoryFact[];
}

let cache: MemoryFact[] = [];
let lastHydrated = 0;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Synchronous snapshot for the retrieval hot path. */
export function learnedFactsCache(): MemoryFact[] {
  return cache;
}

function useValkey(): boolean {
  return hasValkey();
}

async function readFromFile(): Promise<MemoryFact[]> {
  try {
    const raw = await readFile(RUNTIME_PATH, "utf8");
    return (JSON.parse(raw) as LearnedFactsFile).facts ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeToFile(facts: MemoryFact[]): Promise<void> {
  await writeFile(
    RUNTIME_PATH,
    `${JSON.stringify({ facts }, null, 2)}\n`,
    "utf8",
  );
}

/** Authoritative read from the store; refreshes the cache. */
export async function getLearnedFacts(): Promise<MemoryFact[]> {
  let facts: MemoryFact[];
  if (useValkey()) {
    const raw = await getValkey().lrange(LEARNED_KEY, 0, -1);
    facts = raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as MemoryFact;
        } catch {
          return null;
        }
      })
      .filter((f): f is MemoryFact => f !== null);
  } else {
    facts = await readFromFile();
  }
  cache = facts;
  lastHydrated = Date.now();
  return clone(facts);
}

/**
 * Throttled cache refresh for the hot path. Cheap (one Valkey LRANGE / file
 * read) and bounded by a short TTL so a burst of utterances doesn't hammer the
 * store, while a fact written in this meeting still becomes visible quickly.
 */
export async function hydrateLearnedFacts(): Promise<void> {
  if (Date.now() - lastHydrated < HYDRATE_TTL_MS) return;
  try {
    await getLearnedFacts();
  } catch {
    // A store hiccup must never block collision detection.
  }
}

/** Append genuinely new facts, deduped by id and by normalized statement. */
export async function appendLearnedFacts(
  next: MemoryFact[],
): Promise<MemoryFact[]> {
  const current = await getLearnedFacts();
  const seenIds = new Set(current.map((f) => f.id));
  const seenStatements = new Set(current.map((f) => normalize(f.statement)));

  const fresh = next.filter((f) => {
    const stmt = normalize(f.statement);
    if (!f.statement || seenIds.has(f.id) || seenStatements.has(stmt)) {
      return false;
    }
    seenIds.add(f.id);
    seenStatements.add(stmt);
    return true;
  });

  if (fresh.length === 0) return clone(current);

  if (useValkey()) {
    await getValkey().rpush(
      LEARNED_KEY,
      ...fresh.map((f) => JSON.stringify(f)),
    );
  } else {
    await writeToFile([...current, ...fresh]);
  }

  cache = [...current, ...fresh];
  lastHydrated = Date.now();
  return clone(cache);
}

/** Wipe learned facts so the demo scenario can be re-run cleanly. */
export async function resetLearnedFacts(): Promise<void> {
  if (useValkey()) {
    await getValkey().del(LEARNED_KEY);
  } else {
    await writeToFile([]);
  }
  cache = [];
  lastHydrated = Date.now();
}
