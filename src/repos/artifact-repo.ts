import type { ArtifactRecord } from "./records.js";

export interface ArtifactRepo {
  createArtifact(input: {
    ownerType: "workspace" | "job" | "execution_attempt" | "scout_run";
    ownerId: string;
    artifactType: "log" | "rendered_prompt" | "parsed_result" | "plan_prompt" | "plan_context";
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    sha256?: string;
  }): void;
  listArtifacts(ownerType?: string, ownerId?: string): ArtifactRecord[];
}
