export type MemoryCategory =
  | "identity"
  | "preference"
  | "goal"
  | "project"
  | "relationship"
  | "emotional"
  | "behavior"
  | "practice";

export interface Memory {
  id: string;
  category: MemoryCategory;
  text: string;
  embedding?: number[];
  importance?: number; // 1 (minor note) to 5 (critical core fact)
  createdAt?: string;
  updatedAt?: string;
  accessCount?: number;
  lastAccessedAt?: string;
  similarity?: number;
}

export interface MemoryEpisode {
  id: string;
  title: string;
  summary: string;
  keyTakeaways?: string[];
  createdAt: string;
}

export interface MemoryTransaction {
  action: "ADD" | "UPDATE" | "REMOVE";
  id?: string;
  category: MemoryCategory;
  text: string;
  importance?: number;
}

export interface SearchOptions {
  topK?: number;
  minScore?: number;
  category?: MemoryCategory;
  currentQuery?: string;
}
