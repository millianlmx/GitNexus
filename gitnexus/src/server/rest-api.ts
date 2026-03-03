/**
 * REST API Router
 *
 * Exposes all GitNexus CLI features as HTTP endpoints.
 * Mounts on /rest/v1 in the existing Express server.
 *
 * Endpoint groups:
 *   - Tools  (POST /rest/v1/tools/:name)  — MCP tools via LocalBackend.callTool()
 *   - Repos  (GET/POST /rest/v1/repos/*)  — list, status, clean, analyze
 *   - Wiki   (POST /rest/v1/wiki)         — generate wiki
 *   - Health (GET /rest/v1/health)         — health check
 *
 * Long-running operations (analyze, wiki) are async: they return a job ID
 * and progress is polled via GET /rest/v1/jobs/:id.
 */

import { Router, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import type { LocalBackend } from '../mcp/local/local-backend.js';
import {
  findRepo,
  listRegisteredRepos,
  getStoragePaths,
  loadMeta,
  unregisterRepo,
} from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';

// ─── Job Tracking (in-memory) ─────────────────────────────────────────

interface Job {
  id: string;
  type: 'analyze' | 'wiki' | 'clone';
  status: 'running' | 'completed' | 'failed';
  repoPath: string;
  startedAt: string;
  completedAt?: string;
  progress?: string;
  result?: Record<string, unknown>;
  error?: string;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

function createJob(type: Job['type'], repoPath: string): Job {
  const id = `job_${++jobCounter}_${Date.now()}`;
  const job: Job = {
    id,
    type,
    status: 'running',
    repoPath,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  return job;
}

// Evict completed/failed jobs older than 1 hour
function evictOldJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && new Date(job.startedAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

const statusFromError = (err: unknown): number => {
  const msg = String((err as Error)?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  if (msg.includes('required') || msg.includes('Missing')) return 400;
  return 500;
};

const CLONE_BASE_DIR = process.env.GITNEXUS_CLONE_DIR || '/tmp/gitnexus-clones';

const parseGitHubUrl = (url: string): { cloneUrl: string; repoName: string } | null => {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/,
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
    /^github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/.*)?$/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      const repoPath = match[1].replace(/\.git$/, '');
      const cloneUrl = `https://github.com/${repoPath}.git`;
      const repoName = repoPath.replace('/', '-');
      return { cloneUrl, repoName };
    }
  }
  return null;
};

const cloneGitHubRepo = async (githubUrl: string): Promise<{ path: string; cloned: boolean }> => {
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub URL: ${githubUrl}`);
  }

  const { cloneUrl, repoName } = parsed;
  const targetDir = path.join(CLONE_BASE_DIR, repoName);

  await fs.mkdir(CLONE_BASE_DIR, { recursive: true });

  try {
    await fs.access(targetDir);
    const existingRemote = await new Promise<string>((resolve, reject) => {
      execFile('git', ['-C', targetDir, 'remote', 'get-url', 'origin'], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    
    if (existingRemote === cloneUrl) {
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['-C', targetDir, 'fetch', '--all'], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return { path: targetDir, cloned: false };
    }
  } catch {
    // Directory doesn't exist or not a git repo, clone fresh
  }

  await new Promise<void>((resolve, reject) => {
    execFile('git', ['clone', '--depth', '1', cloneUrl, targetDir], { timeout: 300000 }, (err) => {
      if (err) reject(new Error(`Failed to clone ${cloneUrl}: ${err.message}`));
      else resolve();
    });
  });

  return { path: targetDir, cloned: true };
};

const requestedRepo = (req: Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;
  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }
  return undefined;
};

// ─── Router Factory ───────────────────────────────────────────────────

export function createRestRouter(backend: LocalBackend): Router {
  const router = Router();

  // ─── Health ───────────────────────────────────────────────────────

  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const repos = await backend.listRepos();
      res.json({
        status: 'ok',
        version: '1',
        repos: repos.map((r: { name: string }) => r.name),
        uptime: process.uptime(),
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: (err as Error).message });
    }
  });

  // ─── MCP Tools ────────────────────────────────────────────────────

  router.post('/tools/:name', async (req: Request, res: Response) => {
    const toolName = req.params.name;
    const args = req.body || {};

    try {
      const result = await backend.callTool(toolName, args);
      res.json({ tool: toolName, result });
    } catch (err) {
      const status = statusFromError(err);
      res.status(status).json({ tool: toolName, error: (err as Error).message });
    }
  });

  // ─── Repos: List ──────────────────────────────────────────────────
  // GET /rest/v1/repos

  router.get('/repos', async (_req: Request, res: Response) => {
    try {
      const entries = await listRegisteredRepos({ validate: true });
      res.json({
        count: entries.length,
        repos: entries.map(entry => ({
          name: entry.name,
          path: entry.path,
          indexedAt: entry.indexedAt,
          lastCommit: entry.lastCommit,
          stats: entry.stats || {},
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Repos: Status ────────────────────────────────────────────────
  // GET /rest/v1/repos/status?path=/path/to/repo

  router.get('/repos/status', async (req: Request, res: Response) => {
    try {
      const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
      if (!repoPath) {
        res.status(400).json({ error: 'Missing "path" query parameter' });
        return;
      }

      const resolvedPath = path.resolve(repoPath);

      if (!isGitRepo(resolvedPath)) {
        res.status(400).json({ error: 'Not a git repository', path: resolvedPath });
        return;
      }

      const repo = await findRepo(resolvedPath);
      if (!repo) {
        res.json({
          indexed: false,
          path: resolvedPath,
          message: 'Repository not indexed. Use POST /rest/v1/repos/analyze to index it.',
        });
        return;
      }

      const currentCommit = getCurrentCommit(repo.repoPath);
      const isUpToDate = currentCommit === repo.meta.lastCommit;

      res.json({
        indexed: true,
        path: repo.repoPath,
        indexedAt: repo.meta.indexedAt,
        indexedCommit: repo.meta.lastCommit,
        currentCommit,
        upToDate: isUpToDate,
        stats: repo.meta.stats || {},
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Repos: Clean ─────────────────────────────────────────────────
  // DELETE /rest/v1/repos?path=/path/to/repo
  // DELETE /rest/v1/repos?all=true

  router.delete('/repos', async (req: Request, res: Response) => {
    try {
      const all = req.query.all === 'true';

      if (all) {
        const entries = await listRegisteredRepos();
        const results: Array<{ name: string; path: string; deleted: boolean; error?: string }> = [];

        for (const entry of entries) {
          try {
            await fs.rm(entry.storagePath, { recursive: true, force: true });
            await unregisterRepo(entry.path);
            results.push({ name: entry.name, path: entry.path, deleted: true });
          } catch (err) {
            results.push({ name: entry.name, path: entry.path, deleted: false, error: (err as Error).message });
          }
        }

        res.json({ deleted: results.filter(r => r.deleted).length, total: entries.length, results });
        return;
      }

      const repoPath = typeof req.query.path === 'string' ? req.query.path : undefined;
      if (!repoPath) {
        res.status(400).json({ error: 'Missing "path" query parameter (or use ?all=true)' });
        return;
      }

      const resolvedPath = path.resolve(repoPath);
      const repo = await findRepo(resolvedPath);

      if (!repo) {
        res.status(404).json({ error: 'No indexed repository found at this path', path: resolvedPath });
        return;
      }

      await fs.rm(repo.storagePath, { recursive: true, force: true });
      await unregisterRepo(repo.repoPath);
      res.json({ deleted: true, path: repo.repoPath, storagePath: repo.storagePath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Repos: Analyze (async job) ───────────────────────────────────
  // POST /rest/v1/repos/analyze
  // Body: { path?: "/path/to/repo", github?: "https://github.com/owner/repo", force?: boolean, embeddings?: boolean }

  router.post('/repos/analyze', async (req: Request, res: Response) => {
    try {
      const githubUrl = typeof req.body.github === 'string' ? req.body.github : undefined;
      const localPath = typeof req.body.path === 'string' ? req.body.path : undefined;

      if (!githubUrl && !localPath) {
        res.status(400).json({ error: 'Missing "path" or "github" in request body' });
        return;
      }

      let resolvedPath: string;

      if (githubUrl) {
        const cloneResult = await cloneGitHubRepo(githubUrl);
        resolvedPath = cloneResult.path;
      } else {
        resolvedPath = path.resolve(localPath!);
      }

      if (!isGitRepo(resolvedPath)) {
        res.status(400).json({ error: 'Not a git repository', path: resolvedPath });
        return;
      }

      const force = req.body.force === true;
      const embeddings = req.body.embeddings === true;

      if (!force) {
        const { storagePath } = getStoragePaths(resolvedPath);
        const existingMeta = await loadMeta(storagePath);
        const currentCommit = getCurrentCommit(resolvedPath);
        if (existingMeta && existingMeta.lastCommit === currentCommit) {
          res.json({
            status: 'up-to-date',
            path: resolvedPath,
            indexedAt: existingMeta.indexedAt,
            message: 'Already up to date. Use force=true to re-index.',
          });
          return;
        }
      }

      // Spawn analyze as a child process (needs 8GB heap)
      const job = createJob('analyze', resolvedPath);

      // Find the gitnexus CLI entry point
      const cliEntry = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', 'cli', 'index.js'
      );

      const args = [cliEntry, 'analyze', resolvedPath];
      if (force) args.push('--force');
      if (embeddings) args.push('--embeddings');

      const child = execFile(process.execPath, args, {
        env: { ...process.env },
        timeout: 30 * 60 * 1000, // 30 min timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      }, (error, stdout, stderr) => {
        if (error) {
          job.status = 'failed';
          job.completedAt = new Date().toISOString();
          job.error = error.message;
          job.progress = stderr || stdout;
        } else {
          job.status = 'completed';
          job.completedAt = new Date().toISOString();
          job.progress = stdout;

          // Re-init backend to pick up newly indexed repo
          backend.init().catch(() => {});
        }
      });

      // Capture progress updates
      let output = '';
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        job.progress = output;
      });
      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        job.progress = output;
      });

      res.status(202).json({
        status: 'accepted',
        jobId: job.id,
        path: resolvedPath,
        message: 'Analyze job started. Poll GET /rest/v1/jobs/' + job.id + ' for progress.',
      });

      evictOldJobs();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Wiki (async job) ─────────────────────────────────────────────
  // POST /rest/v1/wiki
  // Body: { path: "/path/to/repo", force?: boolean, model?: string, baseUrl?: string, apiKey?: string, concurrency?: number }

  router.post('/wiki', async (req: Request, res: Response) => {
    try {
      const repoPath = typeof req.body.path === 'string' ? req.body.path : undefined;
      if (!repoPath) {
        res.status(400).json({ error: 'Missing "path" in request body' });
        return;
      }

      const resolvedPath = path.resolve(repoPath);

      if (!isGitRepo(resolvedPath)) {
        res.status(400).json({ error: 'Not a git repository', path: resolvedPath });
        return;
      }

      // Check that repo is indexed
      const { storagePath } = getStoragePaths(resolvedPath);
      const meta = await loadMeta(storagePath);
      if (!meta) {
        res.status(400).json({
          error: 'Repository not indexed. Run analyze first.',
          path: resolvedPath,
        });
        return;
      }

      const job = createJob('wiki', resolvedPath);

      // Build CLI args
      const cliEntry = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', 'cli', 'index.js'
      );

      const args = [cliEntry, 'wiki', resolvedPath];
      if (req.body.force === true) args.push('--force');
      if (typeof req.body.model === 'string') args.push('--model', req.body.model);
      if (typeof req.body.baseUrl === 'string') args.push('--base-url', req.body.baseUrl);
      if (typeof req.body.apiKey === 'string') args.push('--api-key', req.body.apiKey);
      if (req.body.concurrency) args.push('--concurrency', String(req.body.concurrency));

      const child = execFile(process.execPath, args, {
        env: { ...process.env },
        timeout: 60 * 60 * 1000, // 60 min timeout for wiki generation
        maxBuffer: 10 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          job.status = 'failed';
          job.completedAt = new Date().toISOString();
          job.error = error.message;
          job.progress = stderr || stdout;
        } else {
          job.status = 'completed';
          job.completedAt = new Date().toISOString();
          job.progress = stdout;

          // Include wiki output path in result
          const wikiDir = path.join(storagePath, 'wiki');
          job.result = { wikiDir, viewerPath: path.join(wikiDir, 'index.html') };
        }
      });

      let output = '';
      child.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
        job.progress = output;
      });
      child.stderr?.on('data', (data: Buffer) => {
        output += data.toString();
        job.progress = output;
      });

      res.status(202).json({
        status: 'accepted',
        jobId: job.id,
        path: resolvedPath,
        message: 'Wiki generation job started. Poll GET /rest/v1/jobs/' + job.id + ' for progress.',
      });

      evictOldJobs();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Jobs ─────────────────────────────────────────────────────────
  // GET /rest/v1/jobs          — list all jobs
  // GET /rest/v1/jobs/:id      — get job status

  router.get('/jobs', (_req: Request, res: Response) => {
    const allJobs = Array.from(jobs.values()).map(j => ({
      id: j.id,
      type: j.type,
      status: j.status,
      repoPath: j.repoPath,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      error: j.error,
    }));
    res.json({ jobs: allJobs });
  });

  router.get('/jobs/:id', (req: Request, res: Response) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({
      id: job.id,
      type: job.type,
      status: job.status,
      repoPath: job.repoPath,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      progress: job.progress,
      result: job.result,
      error: job.error,
    });
  });

  return router;
}
