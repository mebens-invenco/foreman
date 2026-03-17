import type { LearningRecord } from "./records.js";

export interface LearningRepo {
  addLearning(input: {
    id?: string;
    title: string;
    repo: string;
    confidence: "emerging" | "established" | "proven";
    content: string;
    tags: string[];
  }): string;
  updateLearning(input: {
    id: string;
    title?: string;
    repo?: string;
    confidence?: "emerging" | "established" | "proven";
    content?: string;
    tags?: string[];
    markApplied?: boolean;
  }): void;
  listLearnings(filters?: { search?: string; repo?: string; limit?: number; offset?: number }): LearningRecord[];
}
