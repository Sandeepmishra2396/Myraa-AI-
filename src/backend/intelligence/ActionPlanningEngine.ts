/**
 * MYRAA — ActionPlanningEngine
 *
 * Manages active task context and sequential action execution plans:
 * TASK
 * ├── goal
 * ├── currentStep
 * ├── completedSteps
 * ├── pendingStep
 * ├── relevantEntities
 * ├── lastResult
 * └── nextExpectedAction
 *
 * Allows seamless continuation across conversational turns.
 */

import crypto from "crypto";
import { contextFusionEngine } from "./ContextFusionEngine.ts";
import type { TaskState, TaskStep } from "./IntelligenceTypes.ts";

export class ActionPlanningEngine {
  /**
   * Creates a new active task and registers it in ContextFusionEngine.
   */
  public createTask(
    contextId = "default",
    goal: string,
    steps: Array<{ description: string; capability: string; toolName: string; args: Record<string, unknown> }>,
    relevantEntities: TaskState["relevantEntities"] = { files: [], apps: [], urls: [] }
  ): TaskState {
    const taskId = `task_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const taskSteps: TaskStep[] = steps.map((s, idx) => ({
      stepIndex: idx + 1,
      stepId: (s as any).stepId || `step_${idx + 1}`,
      description: s.description,
      capability: s.capability,
      toolName: s.toolName,
      args: s.args,
      status: idx === 0 ? "running" : "pending",
    }));

    const task: TaskState = {
      id: taskId,
      contextId,
      goal,
      status: "active",
      steps: taskSteps,
      currentStepIndex: 1,
      currentStep: taskSteps[0] || null,
      completedSteps: [],
      pendingStep: taskSteps[1] || null,
      relevantEntities,
      lastResult: null,
      nextExpectedAction: taskSteps[1]?.description || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    contextFusionEngine.setActiveTask(contextId, task);
    return task;
  }

  /**
   * Alias / helper for initializing a task with default context.
   */
  public initTask(
    goalOrContextId: string,
    stepsOrGoal: any,
    maybeSteps?: any
  ): TaskState {
    if (Array.isArray(stepsOrGoal)) {
      return this.createTask("default", goalOrContextId, stepsOrGoal);
    }
    return this.createTask(goalOrContextId, stepsOrGoal, maybeSteps || []);
  }

  /**
   * Advances the active task upon completing a step.
   */
  public advanceStep(
    contextIdOrResult: any = "default",
    resultOrVerified?: any,
    verified = true,
    verificationDetails?: string
  ): TaskState | null {
    let contextId = "default";
    let result: unknown = resultOrVerified;
    let isVerified = verified;

    if (typeof contextIdOrResult === "string") {
      contextId = contextIdOrResult;
    } else {
      contextId = "default";
      result = contextIdOrResult;
      isVerified = typeof resultOrVerified === "boolean" ? resultOrVerified : true;
    }

    const task = contextFusionEngine.getActiveTask(contextId);
    if (!task || task.status !== "active") return null;

    if (task.currentStep) {
      task.currentStep.status = "completed";
      task.currentStep.result = result;
      task.currentStep.verified = verified;
      task.currentStep.verificationDetails = verificationDetails;
      task.completedSteps.push({ ...task.currentStep });
    }

    task.lastResult = result;

    const nextIndex = task.currentStepIndex + 1;
    const nextStep = task.steps.find((s) => s.stepIndex === nextIndex);

    if (nextStep) {
      task.currentStepIndex = nextIndex;
      nextStep.status = "running";
      task.currentStep = nextStep;
      task.pendingStep = task.steps.find((s) => s.stepIndex === nextIndex + 1) || null;
      task.nextExpectedAction = task.pendingStep?.description || null;
    } else {
      task.currentStep = null;
      task.pendingStep = null;
      task.status = "completed";
      task.nextExpectedAction = null;
    }

    task.updatedAt = Date.now();
    contextFusionEngine.setActiveTask(contextId, task);
    return task;
  }

  /**
   * Pauses an active task.
   */
  public pauseTask(contextId = "default"): TaskState | null {
    const task = contextFusionEngine.getActiveTask(contextId);
    if (!task) return null;
    task.status = "paused";
    task.updatedAt = Date.now();
    contextFusionEngine.setActiveTask(contextId, task);
    return task;
  }

  /**
   * Resumes a paused task.
   */
  public resumeTask(contextId = "default"): TaskState | null {
    const task = contextFusionEngine.getActiveTask(contextId);
    if (!task) return null;
    task.status = "active";
    task.updatedAt = Date.now();
    contextFusionEngine.setActiveTask(contextId, task);
    return task;
  }

  /**
   * Completes or cancels an active task.
   */
  public finishTask(contextId = "default", status: "completed" | "failed" = "completed"): TaskState | null {
    const task = contextFusionEngine.getActiveTask(contextId);
    if (!task) return null;
    task.status = status;
    task.updatedAt = Date.now();
    contextFusionEngine.setActiveTask(contextId, task);
    return task;
  }
}

export const actionPlanningEngine = new ActionPlanningEngine();
