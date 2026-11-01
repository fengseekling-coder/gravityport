// Exact undo for drag-and-drop operations onto cards/stacks (task 322).
//
// Limitations (matching merge undo):
// - Rebuilding a dissolved stack creates a new stack ID, and the rebuilt stack
//   becomes manual (even if the original was an auto stack).
// - Auto-stack exclusions recorded when moving assets out of a stack are preserved.

export interface StackDropSource {
  stackId: string;
  name: string;
  memberIdsBefore: string[];
  movedAssetIds: string[];
  dissolved: boolean;
  remainingAssetId: string | null;
}

export interface StackDropResult {
  mode: "joined" | "created" | "noop";
  stack: { id: string; name?: string; count?: number } | null;
  sources: StackDropSource[];
  movedAssetIds: string[];
  previouslyLooseAssetIds: string[];
}

export interface StackDropUndoPlan {
  project: string;
  mode: "joined" | "created";
  createdStackId?: string;
  previouslyLooseAssetIds: string[];
  sources: StackDropSource[];
}

export interface StackDropUndoOps {
  moveAssetsToStack: (project: string, assetIds: string[], targetStackId: string | null) => Promise<unknown>;
  createStack: (project: string, ids: string[], coverAssetId?: string) => Promise<{ id: string; name?: string }>;
  renameStack: (project: string, stackId: string, name: string) => Promise<unknown>;
  reorderStack: (project: string, stackId: string, memberIds: string[]) => Promise<unknown>;
  listStackMemberIds: (project: string, stackId: string) => Promise<string[]>;
  dissolveStack: (project: string, stackId: string) => Promise<unknown>;
}

function checkOutcome(outcome: unknown): void {
  if (outcome && typeof outcome === "object" && "failed" in outcome) {
    const failed = Number((outcome as { failed: unknown }).failed);
    if (failed > 0) {
      const firstError = (outcome as { firstError?: string }).firstError;
      throw new Error(firstError || "Operation failed");
    }
  }
}

export function planStackDropUndo(project: string, result: StackDropResult): StackDropUndoPlan | null {
  if (!result || result.mode === "noop" || !result.movedAssetIds.length) {
    return null;
  }
  return {
    project,
    mode: result.mode,
    createdStackId: result.mode === "created" && result.stack ? result.stack.id : undefined,
    previouslyLooseAssetIds: [...result.previouslyLooseAssetIds],
    sources: result.sources.map((source) => ({
      ...source,
      memberIdsBefore: [...source.memberIdsBefore],
      movedAssetIds: [...source.movedAssetIds],
    })),
  };
}

export async function runStackDropUndo(plan: StackDropUndoPlan, ops: StackDropUndoOps): Promise<void> {
  // 1. created: dissolve the newly created stack so all its members become loose.
  if (plan.mode === "created") {
    if (plan.createdStackId) {
      await ops.dissolveStack(plan.project, plan.createdStackId);
    }
  }

  // 2. joined: loosen any assets that were previously loose before being joined.
  if (plan.mode === "joined") {
    if (plan.previouslyLooseAssetIds.length > 0) {
      const outcome = await ops.moveAssetsToStack(plan.project, plan.previouslyLooseAssetIds, null);
      checkOutcome(outcome);
    }
  }

  // 3. For each source stack, restore its members and order.
  for (const source of plan.sources) {
    if (!source.dissolved) {
      const outcome = await ops.moveAssetsToStack(plan.project, source.movedAssetIds, source.stackId);
      checkOutcome(outcome);
      const currentMembers = await ops.listStackMemberIds(plan.project, source.stackId);
      const sameOrder = currentMembers.length === source.memberIdsBefore.length &&
        currentMembers.every((id, idx) => id === source.memberIdsBefore[idx]);
      if (!sameOrder) {
        await ops.reorderStack(plan.project, source.stackId, source.memberIdsBefore);
      }
    } else {
      if (plan.mode === "joined" && source.movedAssetIds.length > 0) {
        const outcome = await ops.moveAssetsToStack(plan.project, source.movedAssetIds, null);
        checkOutcome(outcome);
      }
      if (source.memberIdsBefore.length >= 2) {
        const coverAssetId = source.memberIdsBefore[0];
        const rebuilt = await ops.createStack(plan.project, source.memberIdsBefore, coverAssetId);
        if (source.name) {
          await ops.renameStack(plan.project, rebuilt.id, source.name);
        }
      }
    }
  }
}
