// ─────────────────────────────────────────────────────────────────────────────
// GitLab API Client for Merge Request Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface GitLabConfig {
  baseUrl: string;
  token: string;
}

export interface MRInfo {
  projectPath: string;
  mrIid: number;
  baseUrl: string;
}

export interface MRDetails {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  source_branch: string;
  target_branch: string;
  author: { username: string; name: string };
  web_url: string;
  created_at: string;
  updated_at: string;
  labels: string[];
}

export interface MRDiffFile {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

export interface MRChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

export interface MRChangesResponse {
  changes: MRChange[];
}

export interface DiscussionNote {
  id: number;
  body: string;
  author: { username: string; name: string };
  created_at: string;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number;
    old_line?: number;
  };
}

export interface Discussion {
  id: string;
  notes: DiscussionNote[];
}

/**
 * Parse a GitLab MR URL to extract the project path and MR IID.
 * Supports formats like:
 * - https://gitlab.example.com/group/project/-/merge_requests/123
 * - https://gitlab.example.com/group/project/-/merge_requests/123/diffs
 * - https://gitlab.example.com/group/subgroup/project/-/merge_requests/123
 */
export function parseMRUrl(url: string): MRInfo {
  const urlObj = new URL(url);
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
  
  // Match pattern: /group/[subgroups/]project/-/merge_requests/123[/...]
  const match = urlObj.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  
  if (!match) {
    throw new Error(
      `Invalid GitLab MR URL format. Expected: https://gitlab.example.com/group/project/-/merge_requests/123`
    );
  }

  return {
    projectPath: match[1],
    mrIid: parseInt(match[2], 10),
    baseUrl,
  };
}

/**
 * GitLab API client for merge request operations.
 */
export class GitLabClient {
  private baseUrl: string;
  private token: string;

  constructor(config: GitLabConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitLab API error ${response.status}: ${response.statusText}\n${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get merge request details.
   */
  async getMRDetails(projectPath: string, mrIid: number): Promise<MRDetails> {
    const encodedPath = encodeURIComponent(projectPath);
    return this.request<MRDetails>(
      `/projects/${encodedPath}/merge_requests/${mrIid}`
    );
  }

  /**
   * Get merge request changes (diffs).
   */
  async getMRChanges(
    projectPath: string,
    mrIid: number
  ): Promise<MRChangesResponse> {
    const encodedPath = encodeURIComponent(projectPath);
    return this.request<MRChangesResponse>(
      `/projects/${encodedPath}/merge_requests/${mrIid}/changes`
    );
  }

  /**
   * Get all discussions (comments) on a merge request.
   */
  async getMRDiscussions(
    projectPath: string,
    mrIid: number
  ): Promise<Discussion[]> {
    const encodedPath = encodeURIComponent(projectPath);
    return this.request<Discussion[]>(
      `/projects/${encodedPath}/merge_requests/${mrIid}/discussions`
    );
  }

  /**
   * Create a general comment on the MR (not tied to a specific line).
   */
  async createMRComment(
    projectPath: string,
    mrIid: number,
    body: string
  ): Promise<Discussion> {
    const encodedPath = encodeURIComponent(projectPath);
    return this.request<Discussion>(
      `/projects/${encodedPath}/merge_requests/${mrIid}/discussions`,
      {
        method: "POST",
        body: JSON.stringify({ body }),
      }
    );
  }

  /**
   * Create a comment on a specific line of a file in the MR diff.
   */
  async createMRLineComment(
    projectPath: string,
    mrIid: number,
    body: string,
    position: {
      baseSha: string;
      headSha: string;
      startSha: string;
      newPath: string;
      newLine?: number;
      oldPath?: string;
      oldLine?: number;
    }
  ): Promise<Discussion> {
    const encodedPath = encodeURIComponent(projectPath);
    
    const payload: Record<string, unknown> = {
      body,
      position: {
        base_sha: position.baseSha,
        head_sha: position.headSha,
        start_sha: position.startSha,
        position_type: "text",
        new_path: position.newPath,
        old_path: position.oldPath || position.newPath,
      },
    };

    // Add line numbers - GitLab requires at least one of these
    if (position.newLine) {
      (payload.position as Record<string, unknown>).new_line = position.newLine;
    }
    if (position.oldLine) {
      (payload.position as Record<string, unknown>).old_line = position.oldLine;
    }

    return this.request<Discussion>(
      `/projects/${encodedPath}/merge_requests/${mrIid}/discussions`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }

  /**
   * Get the diff refs (base, head, start SHAs) for a merge request.
   * Needed for posting line-level comments.
   */
  async getMRDiffRefs(
    projectPath: string,
    mrIid: number
  ): Promise<{ base_sha: string; head_sha: string; start_sha: string }> {
    const encodedPath = encodeURIComponent(projectPath);
    const mr = await this.request<{
      diff_refs: { base_sha: string; head_sha: string; start_sha: string };
    }>(`/projects/${encodedPath}/merge_requests/${mrIid}?include_diff_refs=true`);
    
    return mr.diff_refs;
  }
}

/**
 * Format MR changes into a readable diff summary.
 */
export function formatMRDiff(changes: MRChange[]): string {
  return changes
    .map((change) => {
      let header = "";
      if (change.new_file) {
        header = `📄 NEW FILE: ${change.new_path}`;
      } else if (change.deleted_file) {
        header = `🗑️ DELETED: ${change.old_path}`;
      } else if (change.renamed_file) {
        header = `📝 RENAMED: ${change.old_path} → ${change.new_path}`;
      } else {
        header = `📝 MODIFIED: ${change.new_path}`;
      }

      return `${header}\n${"─".repeat(60)}\n${change.diff}`;
    })
    .join("\n\n");
}
