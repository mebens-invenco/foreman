import { type WorkspacePaths } from "../src/workspace/workspace-paths.js";
import { ForemanRepos } from "../src/repos/index.js";
import { SqliteForemanDatabase } from "../src/repos/impl/sqlite-database.js";
export declare const createTempDir: (prefix: string) => Promise<string>;
export declare const createWorkspacePaths: (projectRoot: string, workspaceRoot: string) => WorkspacePaths;
export declare const createMigratedDb: (dbPath: string, projectRoot: string) => Promise<ForemanRepos & {
    database: SqliteForemanDatabase;
}>;
export declare const createLegacyMemoryDb: (dbPath: string) => void;
export declare const createTestConfig: () => {
    version: 1;
    workspace: {
        name: string;
        agentPrefix: string;
    };
    repos: {
        explicit: string[];
        roots: string[];
        ignore: string[];
    };
    taskSystem: {
        type: "file" | "linear";
        linear?: {
            team: string;
            assignee: string;
            includeLabels: string[];
            consolidatedLabel: string;
            states: {
                ready: string[];
                inProgress: string[];
                inReview: string[];
                done: string[];
                canceled: string[];
            };
        } | undefined;
        file?: {
            tasksDir: string;
            idPrefix: string;
            states: {
                ready: string[];
                inProgress: string[];
                inReview: string[];
                done: string[];
                canceled: string[];
            };
        } | undefined;
    };
    reviewSystem: {
        type: "github";
    };
    runner: {
        type: "opencode";
        model: string;
        variant: string;
        timeoutMs: number;
    };
    scheduler: {
        workerConcurrency: number;
        scoutPollIntervalSeconds: number;
        scoutRerunDebounceMs: number;
        leaseTtlSeconds: number;
        workerHeartbeatSeconds: number;
        staleLeaseReapIntervalSeconds: number;
        schedulerLoopIntervalMs: number;
        shutdownGracePeriodSeconds: number;
    };
    http: {
        host: string;
        port: number;
    };
};
