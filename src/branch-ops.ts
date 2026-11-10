/**
 * Offline branch operations for a {@link BrowserRepo}.
 *
 * Slice 3 adds local, offline branching on top of slices 1–2: create, list,
 * delete, and report the current branch, plus checkout (switch) that moves HEAD
 * and rewrites the working tree to match the target branch. Everything runs
 * against the per-repo IndexedDB-backed filesystem through isomorphic-git —
 * there is no network, no clone, no fetch, and no push in this slice.
 *
 * The key invariant this slice guarantees is working-tree isolation: a file
 * committed only on branch A is absent from the working tree after switching to
 * branch B, and reappears when switching back. Checkout is the operation that
 * enforces it.
 *
 * Like {@link GitOps}, this is pure library logic bound to one repository's
 * filesystem and working directory. Branch names are validated against git's
 * ref-format rules before any filesystem work, and every failure surfaces as a
 * typed {@link BrowserReposError} subclass.
 */

import './buffer-polyfill.js';
import git from 'isomorphic-git';
import type { PromiseFs } from './fs-backend.js';
import {
  BranchInUseError,
  BranchNotFoundError,
  InvalidBranchNameError,
  StorageError,
  UncommittedChangesError,
} from './errors.js';

/** The isomorphic-git `fs` shape (its `.promises` is a {@link PromiseFs}). */
type GitFs = { promises: PromiseFs };

/** Options for {@link BranchOps.createBranch}. */
export interface CreateBranchOptions {
  /**
   * Create the branch at this existing ref (branch name or oid) instead of the
   * current HEAD. The ref must resolve, or a {@link BranchNotFoundError} is
   * thrown.
   */
  from?: string;
  /** Move HEAD to the new branch after creating it. Defaults to `false`. */
  checkout?: boolean;
}

/**
 * Validate a git branch name against the subset of `git check-ref-format` rules
 * that matter for local branches. Rejects empty names, leading/trailing/double
 * slashes, control and whitespace characters, the special sequences git
 * forbids (`..`, `@{`, `//`, trailing `.lock`, trailing `/`, a lone `@`), and
 * the characters `~ ^ : ? * [ \` and space. Throws {@link InvalidBranchNameError}.
 */
export function assertValidBranchName(name: string): void {
  const bad = (reason: string): never => {
    throw new InvalidBranchNameError(
      `Invalid branch name "${String(name)}": ${reason}.`,
    );
  };

  if (typeof name !== 'string' || name.length === 0) {
    bad('name must be a non-empty string');
  }
  if (name !== name.trim() || name.length === 0) {
    bad('name must not be empty or padded with whitespace');
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    bad('name must not start or end with "/"');
  }
  if (name.includes('//')) {
    bad('name must not contain an empty path component ("//")');
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    bad('name must not start or end with "."');
  }
  if (name.includes('..')) {
    bad('name must not contain ".."');
  }
  if (name.includes('@{')) {
    bad('name must not contain "@{"');
  }
  if (name === '@') {
    bad('name must not be a single "@"');
  }
  if (name.endsWith('.lock')) {
    bad('name must not end with ".lock"');
  }
  // Control characters, DEL, and the explicitly forbidden set.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    bad('name must not contain control characters, spaces, or any of ~ ^ : ? * [ \\');
  }
  // A path component must not begin with "." (e.g. "foo/.bar").
  for (const component of name.split('/')) {
    if (component.length === 0) {
      bad('name must not contain an empty path component');
    }
    if (component.startsWith('.')) {
      bad('no path component may start with "."');
    }
    if (component.endsWith('.lock')) {
      bad('no path component may end with ".lock"');
    }
  }
}

/**
 * The offline branch operations, bound to one repository's filesystem and
 * working directory. Instances are created internally by {@link BrowserRepo}.
 */
export class BranchOps {
  private readonly fs: GitFs;
  private readonly dir: string;

  /** @internal — constructed by {@link BrowserRepo}. */
  constructor(fs: GitFs, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  /**
   * The name of the branch HEAD currently points at. On an unborn branch (no
   * commits yet) this is still the configured default (e.g. `main`), because
   * HEAD is a symbolic ref before the first commit.
   */
  async currentBranch(): Promise<string> {
    try {
      const name = await git.currentBranch({
        fs: this.fs,
        dir: this.dir,
        fullname: false,
      });
      // On a detached HEAD currentBranch returns undefined; the library keeps
      // HEAD on a branch, so surface the configured default rather than empty.
      return name ?? 'main';
    } catch (err) {
      throw new StorageError('Failed to read the current branch.', err);
    }
  }

  /** List local branch names, sorted. */
  async listBranches(): Promise<string[]> {
    try {
      const names = await git.listBranches({ fs: this.fs, dir: this.dir });
      return [...names].sort((a, b) => a.localeCompare(b));
    } catch (err) {
      throw new StorageError('Failed to list branches.', err);
    }
  }

  /** Whether a local branch with the given (validated) name exists. */
  async hasBranch(name: string): Promise<boolean> {
    assertValidBranchName(name);
    const names = await this.listBranches();
    return names.includes(name);
  }

  /**
   * Create a new branch. By default the branch points at the current HEAD; pass
   * `from` to branch off another existing ref. The new branch is created but
   * HEAD is not moved unless `checkout` is `true`.
   *
   * @throws {InvalidBranchNameError} when `name` is not a valid ref.
   * @throws {BranchNotFoundError} when `from` does not resolve.
   * @throws {StorageError} if the branch already exists or the store fails.
   */
  async createBranch(name: string, options: CreateBranchOptions = {}): Promise<void> {
    assertValidBranchName(name);

    // Branching from a named ref: resolve it first so a bad ref is a clear,
    // typed "not found" rather than a generic storage fault.
    if (options.from !== undefined) {
      let oid: string;
      try {
        oid = await git.resolveRef({ fs: this.fs, dir: this.dir, ref: options.from });
      } catch (err) {
        if (isNotFound(err)) throw new BranchNotFoundError(options.from);
        throw new StorageError(`Failed to resolve ref "${options.from}".`, err);
      }
      try {
        await git.branch({
          fs: this.fs,
          dir: this.dir,
          ref: name,
          object: oid,
          checkout: options.checkout ?? false,
        });
      } catch (err) {
        throw new StorageError(`Failed to create branch "${name}".`, err);
      }
      return;
    }

    try {
      await git.branch({
        fs: this.fs,
        dir: this.dir,
        ref: name,
        checkout: options.checkout ?? false,
      });
    } catch (err) {
      throw new StorageError(`Failed to create branch "${name}".`, err);
    }
  }

  /**
   * Check out (switch to) an existing branch: move HEAD and rewrite the working
   * tree to that branch's content. This is what enforces working-tree
   * isolation — files that exist only on another branch are removed from the
   * working tree on switch, and restored when switching back.
   *
   * To keep the operation safe and predictable, checkout refuses to run while
   * the working tree has uncommitted changes to tracked files, since a switch
   * would overwrite them. Commit or discard first. (Untracked files are left
   * alone and do not block the switch.)
   *
   * @throws {InvalidBranchNameError} when `name` is not a valid ref.
   * @throws {BranchNotFoundError} when no such branch exists.
   * @throws {UncommittedChangesError} when tracked files have unsaved changes.
   */
  async checkout(name: string): Promise<void> {
    assertValidBranchName(name);
    if (!(await this.hasBranch(name))) {
      throw new BranchNotFoundError(name);
    }
    await this.assertWorkingTreeClean(name);
    try {
      await git.checkout({ fs: this.fs, dir: this.dir, ref: name });
    } catch (err) {
      throw new StorageError(`Failed to check out branch "${name}".`, err);
    }
  }

  /**
   * Delete a local branch.
   *
   * @throws {InvalidBranchNameError} when `name` is not a valid ref.
   * @throws {BranchNotFoundError} when no such branch exists.
   * @throws {BranchInUseError} when `name` is the current branch — switch away
   *   first, matching git's refusal to delete the checked-out branch.
   */
  async deleteBranch(name: string): Promise<void> {
    assertValidBranchName(name);
    if (!(await this.hasBranch(name))) {
      throw new BranchNotFoundError(name);
    }
    const current = await this.currentBranch();
    if (name === current) {
      throw new BranchInUseError(name);
    }
    try {
      await git.deleteBranch({ fs: this.fs, dir: this.dir, ref: name });
    } catch (err) {
      throw new StorageError(`Failed to delete branch "${name}".`, err);
    }
  }

  /**
   * Refuse a checkout that would clobber uncommitted work. Reads the status
   * matrix and throws {@link UncommittedChangesError} if any tracked path
   * differs between HEAD/index/working tree. Purely untracked files (absent
   * from HEAD and the index) never block a switch.
   */
  private async assertWorkingTreeClean(target: string): Promise<void> {
    let matrix: Array<[string, number, number, number]>;
    try {
      matrix = (await git.statusMatrix({ fs: this.fs, dir: this.dir })) as Array<
        [string, number, number, number]
      >;
    } catch (err) {
      throw new StorageError('Failed to read working-tree status before checkout.', err);
    }
    for (const row of matrix) {
      const head = row[1];
      const workdir = row[2];
      const stage = row[3];
      // Untracked (absent from HEAD and index) — does not block a switch.
      if (head === 0 && stage === 0) continue;
      // Anything else that is not fully in sync (1,1,1) is uncommitted work.
      if (!(head === 1 && workdir === 1 && stage === 1)) {
        throw new UncommittedChangesError(target);
      }
    }
  }
}

/** Whether an error is isomorphic-git's not-found / unresolved-ref signal. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const name = (err as { name?: unknown }).name;
  return (
    code === 'NotFoundError' ||
    name === 'NotFoundError' ||
    code === 'ResolveRefError' ||
    name === 'ResolveRefError'
  );
}
