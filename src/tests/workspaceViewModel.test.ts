import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { RuleProject, WorkspaceDocument } from '../models/ruleModel';
import type { CheckOperation } from '../services/ruleCheckService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  document: WorkspaceDocument | null = null;
  async load() { return this.document ? structuredClone(this.document) : null; }
  async save(document: WorkspaceDocument) { this.document = structuredClone(document); }
}

class FakeChecker {
  calls = 0;
  nextError: Error | null = null;
  cancelled = false;

  run(project: RuleProject): CheckOperation {
    this.calls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      return { promise: Promise.reject(error), cancel: () => { this.cancelled = true; } };
    }
    return { promise: Promise.resolve(analyzeRules(project)), cancel: () => { this.cancelled = true; } };
  }
}

describe('RuleWorkspaceViewModel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('initializes a usable demo, runs checks, persists edits, and recovers the workspace', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    expect(workspace.getSnapshot().project?.rules).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    const current = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...current, title: '已修改策略' }, '测试编辑', { recheck: false });
    await vi.advanceTimersByTimeAsync(250);
    await workspace.flushSave();
    expect(repository.document?.projects[0].title).toBe('已修改策略');

    const restored = new RuleWorkspaceViewModel(repository, checker);
    await restored.start();
    expect(restored.getSnapshot().project?.title).toBe('已修改策略');
    restored.dispose();
    workspace.dispose();
  });

  it('shows check errors and recovers on the next successful run', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    checker.nextError = new Error('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().phase).toBe('error');
    expect(workspace.getSnapshot().notice).toBe('worker unavailable');
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('success');
    expect(workspace.getSnapshot().analysis).not.toBeNull();
    workspace.dispose();
  });

  it('marks cancellation and blocks checks for invalid projects', async () => {
    const repository = new MemoryRepository();
    const checker = new FakeChecker();
    const workspace = new RuleWorkspaceViewModel(repository, checker);
    await workspace.start();
    const project = workspace.getSnapshot().project as RuleProject;
    workspace.commitProject({ ...project, fields: project.fields.map((field) => field.id === 'cart-total' ? { ...field, min: 10, max: 0 } : field) });
    expect(workspace.getSnapshot().phase).toBe('validating');
    const callsBefore = checker.calls;
    await workspace.runCheck();
    expect(workspace.getSnapshot().checkStatus).toBe('error');
    expect(checker.calls).toBe(callsBefore);
    workspace.dispose();
  });

  it('saves versions, freezes and resumes a version, and copies it into a new project', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    workspace.saveVersion();
    const savedVersion = workspace.getSnapshot().project?.versions[0];
    expect(savedVersion?.frozen).toBe(false);

    workspace.freezeCurrent();
    const frozen = workspace.getSnapshot().project;
    expect(frozen?.frozenVersionId).toBe(frozen?.versions[0].id);
    expect(workspace.commitProject({ ...(frozen as RuleProject), title: '不允许修改' })).toBe(false);

    workspace.restoreVersion(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().project?.frozenVersionId).toBeUndefined();
    workspace.copyVersionToProject(savedVersion?.id ?? '');
    expect(workspace.getSnapshot().workspace?.projects).toHaveLength(2);
    expect(workspace.getSnapshot().project?.fields).toHaveLength(3);
    workspace.dispose();
  });

  describe('rule reveal navigation', () => {
    it('moves to the rules module and leaves the target pending for the rendered list to reveal', async () => {
      const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
      await workspace.start();
      const targetId = (workspace.getSnapshot().project as RuleProject).rules[2].id;

      workspace.revealRule(targetId);
      const state = workspace.getSnapshot();
      expect(state.activeModule).toBe('rules');
      expect(state.selectedRuleId).toBe(targetId);
      expect(state.pendingRuleRevealId).toBe(targetId);

      workspace.completeRuleReveal(targetId, true);
      expect(workspace.getSnapshot().pendingRuleRevealId).toBeUndefined();
      workspace.dispose();
    });

    it('stays in the current module and explains when the target rule no longer exists', async () => {
      const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
      await workspace.start();
      expect(workspace.getSnapshot().activeModule).toBe('inspection');

      workspace.revealRule('rule-that-was-deleted');
      const state = workspace.getSnapshot();
      expect(state.activeModule).toBe('inspection');
      expect(state.pendingRuleRevealId).toBeUndefined();
      expect(state.notice).toContain('已不存在');
      workspace.dispose();
    });

    it('surfaces an explanation when the rendered list cannot find the pending rule', async () => {
      const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
      await workspace.start();
      const targetId = (workspace.getSnapshot().project as RuleProject).rules[0].id;

      workspace.revealRule(targetId);
      workspace.completeRuleReveal(targetId, false);
      const state = workspace.getSnapshot();
      expect(state.pendingRuleRevealId).toBeUndefined();
      expect(state.notice).toContain('已不存在');
      workspace.dispose();
    });

    it('clears the pending reveal when the target is deleted before the list finishes rendering', async () => {
      const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
      await workspace.start();
      const project = workspace.getSnapshot().project as RuleProject;
      const target = project.rules[1];

      workspace.revealRule(target.id);
      expect(workspace.getSnapshot().pendingRuleRevealId).toBe(target.id);
      workspace.commitProject(
        { ...project, rules: project.rules.filter((rule) => rule.id !== target.id) },
        `已删除${target.name}`,
        { recheck: false },
      );
      const state = workspace.getSnapshot();
      expect(state.pendingRuleRevealId).toBeUndefined();
      expect(state.selectedRuleId).not.toBe(target.id);
      expect(state.project?.rules.some((rule) => rule.id === state.selectedRuleId)).toBe(true);
      workspace.dispose();
    });

    it('ignores reveal completions for a request that is no longer pending', async () => {
      const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
      await workspace.start();
      const targetId = (workspace.getSnapshot().project as RuleProject).rules[0].id;

      workspace.completeRuleReveal(targetId, false);
      expect(workspace.getSnapshot().notice).not.toContain('已不存在');
      workspace.dispose();
    });
  });
});
