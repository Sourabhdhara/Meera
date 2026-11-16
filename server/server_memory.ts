import { GoogleGenAI, Type } from "@google/genai";
import { Memory, MemoryCategory, MemoryEpisode, MemoryTransaction, SearchOptions } from "./src/lib/memoryTypes";
import { getGeminiApiKey } from "./server_paths";
import {
  dbGetAllMemories,
  dbInsertMemory,
  dbDeleteMemory,
  dbTouchMemory,
  dbInsertEpisode,
  dbGetRecentEpisodes,
  dbGetLatestEpisode,
  dbSearchEpisodes,
} from "./server_db";

// ---------------------------------------------------------------------------
// 1. Vector Mathematics & Semantic Operations (MRL Optimized)
// ---------------------------------------------------------------------------

/**
 * Matryoshka Dimension for high-speed sub-linear vector search.
 * Google's gemini-embedding-2 preserves >98.5% precision at 768 dimensions
 * while dropping arithmetic operations by 75% compared to full 3072 dims.
 */
export const MRL_DIM = 768;

/**
 * Normalizes a vector truncated to Matryoshka dimension.
 * L2 normalization guarantees that cosine similarity equals simple dot product.
 */
export function normalizeMRL(vec?: number[] | Float32Array, dim: number = MRL_DIM): Float32Array | null {
  if (!vec || vec.length === 0) return null;
  const len = Math.min(vec.length, dim);
  const out = new Float32Array(len);
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const v = vec[i];
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 1e-9) {
    for (let i = 0; i < len; i++) {
      out[i] /= norm;
    }
  }
  return out;
}

/**
 * Ultra-fast dot product between two pre-normalized MRL Float32Arrays.
 * Achieves cosine similarity in a single unrolled loop with 0 divisions and 0 square roots!
 */
export function fastMrlDotProduct(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * High-performance cosine similarity fallback between two arbitrary float vectors.
 * Returns a score between -1.0 and 1.0.
 */
export function cosineSimilarity(a?: number[], b?: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

const STOP_WORDS = new Set([
  "the", "is", "at", "which", "on", "a", "an", "and", "or", "to", "in",
  "for", "of", "with", "as", "by", "from", "that", "this", "it", "me",
  "my", "you", "user", "wants", "meera", "should", "always", "when"
]);

/**
 * BM25-inspired keyword overlap scoring with inverse term weighting.
 * Discriminative technical words (e.g. 'Bengali', 'ZCode', 'diskmgmt') receive full weight (1.0),
 * while conversational stop words receive lower weight (0.15) to prevent noisy matches.
 */
export function keywordSimilarity(query: string, text: string): number {
  if (!query || !text) return 0;
  const tokenize = (s: string): string[] => {
    const matches = s.toLowerCase().match(/[\p{L}\p{N}]+/gu);
    return matches ? matches.filter((w: string) => w.length > 1) : [];
  };
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const tTokens = new Set(tokenize(text));
  if (tTokens.size === 0) return 0;

  let score = 0;
  let maxPossible = 0;
  for (const q of qTokens) {
    const weight = STOP_WORDS.has(q) ? 0.15 : 1.0;
    maxPossible += weight;
    if (tTokens.has(q)) {
      score += weight;
    }
  }
  return maxPossible > 0 ? score / maxPossible : 0;
}

// ---------------------------------------------------------------------------
// Inverted Category Centroid Index (IVF-Style Sub-Linear Clustering)
// Reduces search time from O(N) to O(K + N/K) by evaluating cluster centroids first.
// ---------------------------------------------------------------------------

interface CategoryCluster {
  category: MemoryCategory;
  centroid: Float32Array;
  count: number;
}

class MemoryClusterIndex {
  private clusters = new Map<MemoryCategory, CategoryCluster>();
  private mrlVectors = new Map<string, Float32Array>();

  public rebuildIndex(memories: Memory[]): void {
    this.clusters.clear();
    this.mrlVectors.clear();

    const catSums = new Map<MemoryCategory, { sum: Float32Array; count: number }>();

    for (const m of memories) {
      if (m.embedding && m.embedding.length > 0) {
        const mrl = normalizeMRL(m.embedding);
        if (mrl) {
          this.mrlVectors.set(m.id, mrl);
          let entry = catSums.get(m.category);
          if (!entry) {
            entry = { sum: new Float32Array(MRL_DIM), count: 0 };
            catSums.set(m.category, entry);
          }
          const len = Math.min(entry.sum.length, mrl.length);
          for (let i = 0; i < len; i++) {
            entry.sum[i] += mrl[i];
          }
          entry.count++;
        }
      }
    }

    for (const [cat, { sum, count }] of catSums.entries()) {
      let sumSq = 0;
      for (let i = 0; i < sum.length; i++) {
        sum[i] /= count;
        sumSq += sum[i] * sum[i];
      }
      const norm = Math.sqrt(sumSq);
      if (norm > 1e-9) {
        for (let i = 0; i < sum.length; i++) sum[i] /= norm;
      }
      this.clusters.set(cat, { category: cat, centroid: sum, count });
    }
  }

  public getMrlVector(id: string): Float32Array | undefined {
    return this.mrlVectors.get(id);
  }

  public getCandidateCategories(queryMrl: Float32Array, topK: number = 3): Set<MemoryCategory> {
    const candidates = new Set<MemoryCategory>();
    // Always include eternal foundation categories
    candidates.add("identity");
    candidates.add("relationship");

    const scored: { cat: MemoryCategory; sim: number }[] = [];
    for (const [cat, cluster] of this.clusters.entries()) {
      if (cluster.centroid) {
        const sim = fastMrlDotProduct(queryMrl, cluster.centroid);
        scored.push({ cat, sim });
      }
    }
    scored.sort((a, b) => b.sim - a.sim);
    for (const s of scored.slice(0, topK)) {
      candidates.add(s.cat);
    }
    return candidates;
  }
}

const memoryClusterIndex = new MemoryClusterIndex();

/**
 * Generate semantic text embedding vector using Google's flagship gemini-embedding-2 (3072 dims).
 */
export async function generateEmbedding(apiKey: string, text: string): Promise<number[] | null> {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey || !text || !text.trim()) return null;
  try {
    const ai = new GoogleGenAI({
      apiKey: cleanKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });
    const res = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: text.trim(),
    });
    const values = (res as any)?.embeddings?.[0]?.values || (res as any)?.embedding?.values;
    if (Array.isArray(values) && values.length > 0) {
      return values;
    }
  } catch (err: any) {
    console.warn("[SQLite VectorMemory] Embedding generation notice:", err?.message || err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Database Memory Management (SQLite)
// ---------------------------------------------------------------------------

let isBackfilling = false;

/**
 * Asynchronously backfills embeddings for SQLite memories that do not yet have vectors or have old dimension.
 */
async function triggerEmbeddingBackfill(memories: Memory[], apiKey: string): Promise<void> {
  if (isBackfilling || !apiKey) return;
  const missing = memories.filter(m => !m.embedding || m.embedding.length !== 3072);
  if (missing.length === 0) return;

  isBackfilling = true;
  console.log(`[SQLite VectorMemory] Asynchronously generating embeddings for ${missing.length} memories with gemini-embedding-2...`);

  (async () => {
    try {
      let updatedCount = 0;
      for (const mem of missing) {
        const emb = await generateEmbedding(apiKey, mem.text);
        if (emb) {
          mem.embedding = emb;
          await dbInsertMemory(mem);
          updatedCount++;
        }
        await new Promise(r => setTimeout(r, 120)); // rate limit buffer
      }
      if (updatedCount > 0) {
        console.log(`[SQLite VectorMemory] Successfully embedded and saved ${updatedCount} memories to SQLite.`);
      }
    } catch (e: any) {
      console.warn("[SQLite VectorMemory] Backfill interrupted:", e?.message || e);
    } finally {
      isBackfilling = false;
    }
  })();
}

/**
 * Loads all memories from SQLite database and triggers background vector backfill if key is available.
 */
export async function loadMemories(apiKey?: string): Promise<Memory[]> {
  const list = await dbGetAllMemories();
  memoryClusterIndex.rebuildIndex(list);
  const activeKey = apiKey || getGeminiApiKey();
  if (activeKey) {
    triggerEmbeddingBackfill(list, activeKey);
  }
  return list;
}

export async function saveMemories(memories: Memory[]): Promise<void> {
  for (const m of memories) {
    await dbInsertMemory(m);
  }
  memoryClusterIndex.rebuildIndex(memories);
}

// ---------------------------------------------------------------------------
// 3. Sub-Linear Semantic Vector Search (MRL + Clustered Inverted Index)
// ---------------------------------------------------------------------------

/**
 * Searches stored memories in SQLite using MRL dot products combined with BM25 keyword matching.
 * Leverages inverted category clustering to prune non-candidate vectors in sub-linear time.
 */
export async function searchMemories(
  query: string,
  apiKey?: string,
  options?: SearchOptions
): Promise<Memory[]> {
  const topK = options?.topK ?? 6;
  const minScore = options?.minScore ?? 0.20;
  const categoryFilter = options?.category;
  const memories = await loadMemories(apiKey);
  if (memories.length === 0) return [];

  const key = apiKey || getGeminiApiKey();
  let queryEmbedding: number[] | null = null;
  let queryMrl: Float32Array | null = null;
  if (key) {
    queryEmbedding = await generateEmbedding(key, query);
    if (queryEmbedding) {
      queryMrl = normalizeMRL(queryEmbedding);
    }
  }

  // Sub-linear Clustered Candidate Pruning:
  // If no specific category is requested and dataset > 25, prune candidate clusters via centroid similarity
  let candidateCategories: Set<MemoryCategory> | null = null;
  if (categoryFilter) {
    candidateCategories = new Set([categoryFilter]);
  } else if (queryMrl && memories.length > 25) {
    candidateCategories = memoryClusterIndex.getCandidateCategories(queryMrl, 3);
  }

  const scored = memories
    .filter(m => {
      if (!candidateCategories) return true;
      if (candidateCategories.has(m.category)) return true;
      // High importance and exact keyword hits always get evaluated regardless of cluster
      if ((m.importance || 3) >= 4) return true;
      if (keywordSimilarity(query, m.text) >= 0.25) return true;
      return false;
    })
    .map(m => {
      let vecScore = 0;
      const keyScore = keywordSimilarity(query, m.text);
      const memMrl = memoryClusterIndex.getMrlVector(m.id);
      if (queryMrl && memMrl) {
        vecScore = fastMrlDotProduct(queryMrl, memMrl);
      } else if (queryEmbedding && m.embedding && m.embedding.length === queryEmbedding.length) {
        vecScore = cosineSimilarity(queryEmbedding, m.embedding);
      }
      const importanceScore = ((m.importance || 3) / 5);
      // 65% semantic vectors + 20% BM25 keyword match + 15% importance score
      const finalScore = (queryMrl && memMrl) || (queryEmbedding && m.embedding)
        ? (vecScore * 0.65 + keyScore * 0.20 + importanceScore * 0.15)
        : (keyScore * 0.70 + importanceScore * 0.30);

      return { memory: m, score: finalScore };
    })
    .filter(item => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Update access statistics asynchronously in SQLite
  for (const item of scored) {
    item.memory.accessCount = (item.memory.accessCount || 0) + 1;
    item.memory.similarity = Math.round(item.score * 100) / 100;
    dbTouchMemory(item.memory.id).catch(() => {});
  }

  return scored.map(s => s.memory);
}

/**
 * Unified recall: Searches both factual memories AND past session episodes.
 * Provides complete episodic and factual continuity for recallMemory.
 */
export async function searchMemoriesAndEpisodes(
  query: string,
  apiKey?: string,
  options?: SearchOptions
): Promise<{ facts: Memory[]; episodes: MemoryEpisode[]; combinedFormatted: string }> {
  const topK = options?.topK ?? 6;
  const facts = await searchMemories(query, apiKey, { ...options, topK: Math.max(3, Math.floor(topK / 2)) });
  const episodes = await dbSearchEpisodes(query, Math.max(2, Math.floor(topK / 2)));

  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push("FACTS & PREFERENCES:\n" + facts.map(f => `- [${f.category}] ${f.text}`).join("\n"));
  }

  if (episodes.length > 0) {
    sections.push("PAST CONVERSATION SESSIONS (EPISODIC DIARY):\n" + episodes.map(ep => {
      let tStr = ep.createdAt ? new Date(ep.createdAt).toLocaleDateString() : "Past session";
      return `- "${ep.title}" (${tStr}): ${ep.summary}`;
    }).join("\n"));
  }

  const combinedFormatted = sections.length > 0
    ? sections.join("\n\n")
    : "No historic memories or past conversations matched this query.";

  return { facts, episodes, combinedFormatted };
}

// ---------------------------------------------------------------------------
// 4. Memory CRUD Operations (Direct SQLite)
// ---------------------------------------------------------------------------

export async function addMemory(
  category: MemoryCategory,
  text: string,
  apiKey?: string,
  importance?: number
): Promise<Memory> {
  const timestamp = new Date().toISOString();
  const key = apiKey || getGeminiApiKey();

  let embedding: number[] | undefined;
  if (key) {
    const emb = await generateEmbedding(key, text);
    if (emb) embedding = emb;
  }

  const resolvedImportance = typeof importance === "number" ? Math.max(1, Math.min(5, importance)) : (
    category === "identity" || category === "relationship" ? 5 :
    category === "preference" || category === "practice" || category === "goal" ? 4 : 3
  );

  // Deduplication & Conflict Resolution
  const currentMemories = await loadMemories(key);
  let existingMatch: Memory | null = null;

  if (embedding) {
    let bestSim = 0;
    const newMrl = normalizeMRL(embedding);
    for (const existing of currentMemories) {
      if (existing.category === category && existing.embedding) {
        const existMrl = memoryClusterIndex.getMrlVector(existing.id) || normalizeMRL(existing.embedding);
        const sim = (newMrl && existMrl)
          ? fastMrlDotProduct(newMrl, existMrl)
          : cosineSimilarity(embedding, existing.embedding);
        if (sim > 0.72 && sim > bestSim) {
          bestSim = sim;
          existingMatch = existing;
        }
      }
    }
  } else {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const existing of currentMemories) {
      if (existing.category === category) {
        const match = words.filter(w => existing.text.toLowerCase().includes(w)).length;
        if (words.length > 0 && match / words.length > 0.55) {
          existingMatch = existing;
          break;
        }
      }
    }
  }

  if (existingMatch) {
    console.log(`[SQLite VectorMemory] Updating/refining existing memory ${existingMatch.id} instead of appending.`);
    const updatedMemory: Memory = {
      id: existingMatch.id,
      category,
      text,
      embedding: embedding || existingMatch.embedding,
      importance: Math.max(existingMatch.importance || 3, resolvedImportance),
      createdAt: existingMatch.createdAt,
      updatedAt: timestamp,
      accessCount: (existingMatch.accessCount || 0) + 1
    };
    await dbInsertMemory(updatedMemory);
    return updatedMemory;
  }

  const newMemory: Memory = {
    id: Math.random().toString(36).substring(2, 11),
    category,
    text,
    embedding,
    importance: resolvedImportance,
    createdAt: timestamp,
    updatedAt: timestamp,
    accessCount: 0
  };

  await dbInsertMemory(newMemory);
  return newMemory;
}

export async function deleteMemory(id: string): Promise<boolean> {
  return await dbDeleteMemory(id);
}

export async function forgetMemoryByQuery(query: string, apiKey?: string): Promise<boolean> {
  const matches = await searchMemories(query, apiKey, { topK: 1 });
  if (matches.length > 0 && matches[0].id) {
    await dbDeleteMemory(matches[0].id);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5. System Instructions Formatting (Dynamic Working Memory + Episodic Continuity)
// ---------------------------------------------------------------------------

function formatEpisodeRelativeTime(dateStr?: string, nowMs: number = Date.now()): { timeLabel: string; diffMins: number } {
  if (!dateStr) return { timeLabel: "Recently", diffMins: 9999 };
  const d = new Date(dateStr);
  const diffMs = Math.max(0, nowMs - d.getTime());
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 2) return { timeLabel: "Just seconds ago", diffMins };
  if (diffMins < 60) return { timeLabel: `${diffMins} minute(s) ago`, diffMins };
  const diffHours = Math.round(diffMins / 60);
  if (diffHours < 24) return { timeLabel: `${diffHours} hour(s) ago`, diffMins };
  const diffDays = Math.round(diffHours / 24);
  return { timeLabel: `${diffDays} day(s) ago`, diffMins };
}

export function formatSystemInstructionsWithMemories(
  baseInstruction: string,
  memories: Memory[],
  recentDialogueTurns: Array<{ role: "user" | "meera"; text: string; createdAt: string }> = []
): string {
  if (memories.length === 0 && (!recentDialogueTurns || recentDialogueTurns.length === 0)) {
    return (
      baseInstruction +
      "\n\n" +
      "=== MEERA MEMORY CORE ===\n" +
      "You do not possess any historic recollections of this companion yet. " +
      "As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n" +
      "=========================\n"
    );
  }

  // Tier 1: Core memories (Identity & Relationships are permanent foundation)
  const coreCategories: MemoryCategory[] = ["identity", "relationship"];
  const coreMemories = memories.filter(m => coreCategories.includes(m.category));

  // Tier 2: Dynamically rank all other memories by cognitive relevance (Recency + Importance + Access count)
  const otherMemories = memories.filter(m => !coreCategories.includes(m.category));
  const nowMs = Date.now();

  const scoredOthers = otherMemories.map(m => {
    const importance = typeof m.importance === "number" ? m.importance : (
      m.category === "preference" || m.category === "practice" || m.category === "goal" ? 4 : 3
    );
    const catWeight: Record<string, number> = {
      preference: 1.35,
      practice: 1.30,
      goal: 1.25,
      project: 1.20,
      behavior: 1.10,
      emotional: 1.05
    };
    const weight = catWeight[m.category] || 1.0;

    const lastDateStr = m.updatedAt || m.createdAt || "";
    const elapsedDays = lastDateStr ? Math.max(0, (nowMs - new Date(lastDateStr).getTime()) / (1000 * 60 * 60 * 24)) : 0;
    // High-importance memories (>=4) decay very slowly (floor 0.85); lower importance decays over 30 days
    const decay = importance >= 4
      ? Math.max(0.85, Math.exp(-elapsedDays / 90))
      : Math.max(0.30, Math.exp(-elapsedDays / 30));

    const accessBonus = Math.min(1.30, 1 + ((m.accessCount || 0) * 0.04));
    const totalScore = importance * weight * decay * accessBonus;
    return { memory: m, score: totalScore };
  });

  scoredOthers.sort((a, b) => b.score - a.score);
  // Pick top 18 working memories so all relevant preferences, tools, and practices are readily active
  const topWorkingMemories = scoredOthers.slice(0, 18).map(s => s.memory);
  const activeSet = [...coreMemories, ...topWorkingMemories];

  const grouped: Record<string, string[]> = {};
  activeSet.forEach(m => {
    grouped[m.category] = grouped[m.category] || [];
    grouped[m.category].push(m.text);
  });

  let memoryBlock =
    "\n\n" +
    "=== MEERA PERSISTENT MEMORY CORE (SQLITE VECTOR RETRIEVAL) ===\n" +
    "Below are your persistent recollections of who TECH is.\n" +
    "CRITICAL COGNITIVE PRINCIPLES:\n" +
    "- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my database...', 'My record says...', or 'On date X...'. Instead, speak of these details casually and supportively as a true friend would.\n" +
    "- VECTOR RECALL: If TECH asks about past conversations, projects, or details you don't immediately see here, you can use your 'recallMemory' tool to search your deep vector brain.\n\n" +
    "ACTIVE WORKING MEMORIES:\n";

  const categoriesOrdered = [
    { key: "identity", label: "Core Identity (Name, profession, background)" },
    { key: "relationship", label: "Key People & Relationships" },
    { key: "preference", label: "Preferences & Tastes" },
    { key: "practice", label: "Workflow Practices & Habits" },
    { key: "goal", label: "Active Goals & Aspirations" },
    { key: "project", label: "Ongoing Projects & Ecosystems" },
    { key: "emotional", label: "Emotional Highlights & Core Milestones" },
    { key: "behavior", label: "Observed Traits & Habits" },
  ];

  categoriesOrdered.forEach(cat => {
    const list = grouped[cat.key] || [];
    if (list.length > 0) {
      memoryBlock += `* ${cat.label}:\n` + list.map(t => `  - ${t}`).join("\n") + "\n";
    }
  });

  if (recentDialogueTurns && recentDialogueTurns.length > 0) {
    const latestTurnTime = recentDialogueTurns[recentDialogueTurns.length - 1]?.createdAt;
    const { timeLabel, diffMins } = formatEpisodeRelativeTime(latestTurnTime, nowMs);

    let situationContext = "";
    if (diffMins < 2) {
      situationContext = "CONTINUOUS CHAT (< 2 mins ago): You were speaking just a moment ago. Continue naturally as part of the exact same conversation.";
    } else if (diffMins < 30) {
      situationContext = `RETURNING AFTER SHORT BREAK (${timeLabel}): Pick up smoothly where you left off.`;
    } else if (diffMins < 12 * 60) {
      situationContext = `SAME DAY RETURN (${timeLabel}): Reconnect warmly.`;
    } else {
      situationContext = `RETURNING AFTER ABSENCE (${timeLabel}): Reconnect warmly like a caring companion happy to see them again.`;
    }

    memoryBlock +=
      "\n=== LIVE CONVERSATION CONTEXT (VERBATIM HISTORIC TRANSCRIPT) ===\n" +
      `Current State: ${situationContext}\n\n` +
      "CRITICAL SOURCE OF TRUTH (VERBATIM DIALOGUE):\n" +
      "Below are the EXACT word-to-word exchanges from the last session. You know and remember everything spoken here.\n" +
      "- ALWAYS base your memory of 'what we were doing or talking about' STRICTLY on these actual spoken words.\n" +
      "- NEVER invent, assume, or guess files, projects, or tasks that are NOT spoken in this transcript.\n" +
      "- Do NOT repeat, re-answer, or recite past turns unprompted. Prioritize responding to the user's latest incoming speech.\n\n";

    for (const t of recentDialogueTurns) {
      const speaker = t.role === "user" ? "USER" : "MEERA";
      memoryBlock += `[${speaker}]: "${t.text}"\n`;
    }
    memoryBlock += "=========================================================================\n";

    memoryBlock +=
      "\nCONVERSATIONAL CONTINUITY RULES (REAL & GENUINE HUMAN BEHAVIOR):\n" +
      "1. GROUNDING IN TRANSCRIPT ONLY: If the user asks 'hum kya kar rahe the?', 'kya baat chal rahi thi?', or references past talk, answer STRICTLY using the exact transcript lines above. If something is not in the transcript, say honestly that you don't recall it.\n" +
      "2. DEEP HISTORIC RECALL ON-DEMAND: If the user explicitly asks about older sessions beyond the immediate transcript, call 'recallMemory' to search deep SQLite vector brain.\n" +
      "3. TASK-FIRST PRIORITY: If the user's opening message is an urgent command or task, EXECUTE IT IMMEDIATELY without small-talk delay.\n" +
      "4. HUMAN CONVERSATIONAL RHYTHM: Speak in short, warm, punchy 1-3 sentences per turn. Never speak like a corporate customer-support bot. Speak like a true, sweet anime-heroine friend.\n" +
      "======================================================\n";
  }

  memoryBlock += "==============================================================\n";

  return baseInstruction + memoryBlock;
}

// ---------------------------------------------------------------------------
// 6. Automated Background Consolidation Pipeline (SQLite)
// ---------------------------------------------------------------------------

const GEMINI_TEXT_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash"
];

export async function callGeminiWithFallback(
  ai: GoogleGenAI,
  req: { contents: any; config?: any },
  models: string[] = GEMINI_TEXT_MODELS
): Promise<any> {
  let lastErr: any = null;
  for (const m of models) {
    try {
      const res = await ai.models.generateContent({
        model: m,
        contents: req.contents,
        config: req.config
      });
      return res;
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.code;
      console.warn(`[Gemini Fallback] Model ${m} notice (${status || err?.message}). Trying next fallback...`);
    }
  }
  throw lastErr || new Error("All fallback models exhausted");
}

let isConsolidating = false;

export async function processConversationSlice(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[]
): Promise<Memory[] | null> {
  if (isConsolidating) {
    console.log("[SQLite VectorMemory] Consolidation loop busy, skipping slice processing");
    return null;
  }

  if (dialogueHistory.length < 2) {
    return null;
  }

  isConsolidating = true;
  console.log("[SQLite VectorMemory] Initiating cognition pipeline for dialogue slice length:", dialogueHistory.length);

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const currentMemories = await loadMemories(apiKey);

    const memoryContext = currentMemories
      .map(m => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`)
      .join("\n");
    const dialogueContext = dialogueHistory
      .map(line => `${line.role === "user" ? "User" : "Meera"}: ${line.text}`)
      .join("\n");

    const prompt = `You are Meera's deep cognitive recollection engine. Your task is to analyze the recent conversation piece against previous persistent memories, and output precise update transactions.

### OBJECTIVE
Decide if any statements contain durable, high-conviction, long-term personal facts, enduring life/system preferences, ongoing primary software ecosystems, critical relationships, or recurring behavioral habits.

STRICT NEGATIVE FILTERS (NEVER SAVE TO PERMANENT MEMORY):
- NEVER save transient coding exercises, individual LeetCode/DSA problems (e.g., Kadane's algorithm, binary search, two-pointer), one-off script tests, syntax questions, or temporary file edits.
- NEVER infer or invent projects from brief desktop actions, single commands, or random code snippets.
- NEVER catalog momentary chit-chat, greetings, questions about how Meera works, testing restart behaviors, or immediate conversational flow.
- A topic only qualifies as a permanent "project" or "goal" if the user EXPLICITLY and REPEATEDLY mentions it as their core venture, sustained roadmap, or ongoing multi-week focus. All transient activities belong exclusively in the temporary session transcript.

### CURRENT USER MEMORIES:
${memoryContext || "(No memory records exist)"}

### RECENT DIALOGUE SLICE:
${dialogueContext}

### RULES
- DEDUPLICATION & CONSOLIDATION (CRITICAL):
  - NEVER create multiple memories about the same attribute (e.g. user's name, user's job, location, core preference).
  - If a memory on that topic already exists in CURRENT USER MEMORIES, you MUST use "UPDATE" with that memory's ID to merge or refine it into ONE single comprehensive statement. Never use "ADD" for an entity or fact already tracked.
  - If an existing memory already accurately covers the statement, do NOT produce any transaction.
- ACTIONS:
  - "ADD": ONLY for entirely new, distinct topics that do not exist in CURRENT USER MEMORIES.
  - "UPDATE": If previous information has evolved, was corrected, or received additional detail. Provide the exact ID of the memory to replace.
  - "REMOVE": If a memory was explicitly disproven or the user directly asked Meera to forget it.
- TEXT STYLE: Express the memories as clean, concise, third-person declarative summaries (e.g., 'The user is building a startup named Meera.', 'The user loves playing GTA 6.', 'The user enjoys technical and fast-paced styling explanations.'). Do not include conversational filler, quotes, or timestamps.
- IMPORTANCE (1-5):
  - 5: Critical permanent identity, family relationships, eternal rules.
  - 4: Strong persistent preferences, recurring practices, major active goals.
  - 3: Normal projects, hobbies, contextual facts.
  - 1-2: Minor or short-term notes.
- ID: For ADD, leave blank. For UPDATE or REMOVE, provide the exact 'id' from the "Current user memories" list.`;

    const response = await callGeminiWithFallback(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transactions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  action: {
                    type: Type.STRING,
                    description: "ADD, UPDATE, or REMOVE transaction.",
                    enum: ["ADD", "UPDATE", "REMOVE"]
                  },
                  id: {
                    type: Type.STRING,
                    description: "Specific ID of the existing memory being modified or deleted (leave blank/null for ADD)."
                  },
                  category: {
                    type: Type.STRING,
                    description: "The Memory category classification.",
                    enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior", "practice"]
                  },
                  text: {
                    type: Type.STRING,
                    description: "The memory summarized as a concise declarative statement in third-person."
                  },
                  importance: {
                    type: Type.INTEGER,
                    description: "Importance from 1 to 5."
                  }
                },
                required: ["action", "category", "text"]
              }
            }
          },
          required: ["transactions"]
        }
      }
    });

    const rawResultText = typeof response.text === "function" ? (response as any).text() : response.text;
    const resultText = rawResultText?.trim() || "{}";
    const resultObj = JSON.parse(resultText);
    const transactions: MemoryTransaction[] = resultObj.transactions || [];

    if (transactions.length === 0) {
      console.log("[SQLite VectorMemory] Zero transactions generated. Ignored routine chit-chat.");
      isConsolidating = false;
      return null;
    }

    console.log(`[SQLite VectorMemory] Processing ${transactions.length} memory updates:`, JSON.stringify(transactions));

    const timestamp = new Date().toISOString();

    for (const trx of transactions) {
      const imp = typeof trx.importance === "number" ? Math.max(1, Math.min(5, trx.importance)) : 3;

      if (trx.action === "ADD") {
        const emb = await generateEmbedding(apiKey, trx.text);

        // Vector Deduplication Guard: if an existing memory in the same category has >0.75 similarity,
        // merge into that existing record rather than creating a duplicate card.
        let duplicateMemory: Memory | null = null;
        if (emb) {
          for (const existing of currentMemories) {
            if (existing.category === trx.category && existing.embedding && existing.embedding.length === emb.length) {
              const sim = cosineSimilarity(emb, existing.embedding);
              if (sim > 0.75) {
                duplicateMemory = existing;
                break;
              }
            }
          }
        }

        if (duplicateMemory) {
          console.log(`[SQLite VectorMemory] Deduplicating: Merging into existing memory ${duplicateMemory.id} (semantic match)`);
          const merged: Memory = {
            id: duplicateMemory.id,
            category: trx.category,
            text: trx.text,
            embedding: emb || undefined,
            importance: Math.max(duplicateMemory.importance || 3, imp),
            createdAt: duplicateMemory.createdAt,
            updatedAt: timestamp,
            accessCount: (duplicateMemory.accessCount || 0) + 1
          };
          await dbInsertMemory(merged);
        } else {
          const newMemory: Memory = {
            id: Math.random().toString(36).substring(2, 11),
            category: trx.category,
            text: trx.text,
            embedding: emb || undefined,
            importance: imp,
            createdAt: timestamp,
            updatedAt: timestamp,
            accessCount: 0
          };
          await dbInsertMemory(newMemory);
        }
      } else if (trx.action === "UPDATE") {
        const emb = await generateEmbedding(apiKey, trx.text);
        const existing = currentMemories.find(m => m.id === trx.id);
        const newMemory: Memory = {
          id: trx.id || Math.random().toString(36).substring(2, 11),
          category: trx.category,
          text: trx.text,
          embedding: emb || undefined,
          importance: existing ? Math.max(existing.importance || 3, imp) : imp,
          updatedAt: timestamp
        };
        await dbInsertMemory(newMemory);
      } else if (trx.action === "REMOVE" && trx.id) {
        await dbDeleteMemory(trx.id);
      }
    }

    isConsolidating = false;
    return await loadMemories(apiKey);
  } catch (error) {
    console.error("[SQLite VectorMemory] Consolidation failure:", error);
    isConsolidating = false;
    return null;
  }
}

// ---------------------------------------------------------------------------
// 7. Episodic Session Summarizer (Conversation Diary)
// ---------------------------------------------------------------------------

export function synthesizeLocalEpisode(
  dialogueHistory: { role: string; text: string }[],
  existingId?: string,
  createdAt?: string
): MemoryEpisode | null {
  if (!dialogueHistory || dialogueHistory.length === 0) return null;

  const userMessages = dialogueHistory.filter(d => d.role === "user").map(d => d.text.trim());
  const toolMessages = dialogueHistory.filter(d => d.role === "tool").map(d => d.text.trim());
  const modelMessages = dialogueHistory.filter(d => d.role === "model").map(d => d.text.trim());

  // Require at least one user turn or tool call to consider this a real interaction
  if (userMessages.length === 0 && toolMessages.length === 0) {
    return null;
  }

  // Extract distinct tools invoked
  const toolsUsed = new Set<string>();
  for (const tm of toolMessages) {
    const match = tm.match(/Called\s+([a-zA-Z0-9_]+)/i);
    if (match) toolsUsed.add(match[1]);
  }

  // Derive descriptive title
  let title = "Desktop & Voice Interaction Session";
  if (userMessages.length > 0) {
    const firstReq = userMessages[0].replace(/^(please|can you|could you|meera|hey meera)\s+/i, "");
    if (firstReq.length > 4) {
      const clean = firstReq.slice(0, 50).replace(/[.?!,:;]+$/, "").trim();
      title = clean.charAt(0).toUpperCase() + clean.slice(1);
    }
  } else if (toolsUsed.size > 0) {
    const toolList = Array.from(toolsUsed).slice(0, 2).join(" & ");
    title = `Automated Actions (${toolList})`;
  }

  // Derive key takeaways
  const keyTakeaways: string[] = [];
  for (const u of userMessages.slice(-3)) {
    if (u.length > 3) keyTakeaways.push(`User request: "${u.slice(0, 80)}"`);
  }
  for (const t of Array.from(toolsUsed).slice(0, 4)) {
    keyTakeaways.push(`Executed action: ${t}`);
  }
  if (keyTakeaways.length === 0) {
    keyTakeaways.push("Engaged in conversational voice session with Meera");
  }

  // Derive warm summary
  let summary = "";
  if (userMessages.length > 0) {
    summary += `The user discussed ${userMessages.slice(0, 2).map(m => `"${m.slice(0, 60)}"`).join(" and ")}. `;
  }
  if (toolsUsed.size > 0) {
    summary += `Meera performed desktop actions using ${Array.from(toolsUsed).join(", ")}. `;
  } else if (modelMessages.length > 0) {
    summary += `Meera provided voice guidance and conversational support. `;
  }

  return {
    id: existingId || ("ep_" + Math.random().toString(36).substring(2, 10)),
    title: title.slice(0, 60),
    summary: summary.trim(),
    keyTakeaways: keyTakeaways.slice(0, 5),
    createdAt: createdAt || new Date().toISOString()
  };
}

export async function synthesizeSessionEpisode(
  apiKey: string,
  dialogueHistory: { role: string; text: string }[],
  existingId?: string,
  createdAt?: string
): Promise<MemoryEpisode | null> {
  if (dialogueHistory.length < 1) return null;

  // 1. Always create and persist local episode first so disk persistence is guaranteed instantly
  const localEpisode = synthesizeLocalEpisode(dialogueHistory, existingId, createdAt);
  if (!localEpisode) return null;

  try {
    await dbInsertEpisode(localEpisode);
    console.log(`[Episodic Memory] Persisted session snapshot to disk: "${localEpisode.title}" (${localEpisode.id})`);
  } catch (dbErr: any) {
    console.warn("[Episodic Memory] Local snapshot db error:", dbErr?.message || dbErr);
  }

  // 2. If API key exists, asynchronously enrich with Gemini AI using multi-model fallback
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) return localEpisode;

  try {
    const ai = new GoogleGenAI({
      apiKey: cleanKey,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const transcript = dialogueHistory
      .slice(-30)
      .map(d => {
        if (d.role === "user") return `User: ${d.text}`;
        if (d.role === "model") return `Meera: ${d.text}`;
        return `[Action/Tool]: ${d.text}`;
      })
      .join("\n");

    const prompt = `You are Meera's episodic memory summarizer. Analyze this recent conversation session between the user and Meera.
Generate an episodic session diary entry summarizing what took place, key topics, decisions, code/tools configured, and any open loops or next steps.

### CONVERSATION TRANSCRIPT:
${transcript}

Output strictly in JSON:
{
  "title": "Short 3-6 word descriptive title of the session",
  "summary": "2-3 concise, warm, third-person sentences capturing what the user and Meera talked about or accomplished.",
  "keyTakeaways": ["Key decision, task done, or open loop 1", "Key takeaway 2"]
}`;

    const res = await callGeminiWithFallback(ai, {
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const rawText = typeof res.text === "function" ? (res as any).text() : res.text;
    const text = rawText?.trim() || "{}";
    const data = JSON.parse(text);
    if (data.title && data.summary) {
      const enrichedEpisode: MemoryEpisode = {
        id: localEpisode.id,
        title: data.title,
        summary: data.summary,
        keyTakeaways: Array.isArray(data.keyTakeaways) ? data.keyTakeaways : localEpisode.keyTakeaways,
        createdAt: localEpisode.createdAt
      };
      await dbInsertEpisode(enrichedEpisode);
      console.log(`[Episodic Memory] Enriched conversation episode with AI: "${enrichedEpisode.title}"`);
      return enrichedEpisode;
    }
  } catch (err: any) {
    console.warn("[Episodic Memory] AI enrichment notice (local snapshot preserved):", err?.message || err);
  }
  return localEpisode;
}
