export interface TeamInfo { id: string; key: string; name: string; role: string; perms: string[]; mcpScopes?: string[]; [k: string]: any }
export interface Me { id: string; name: string; email: string; admin?: boolean; teams: TeamInfo[]; invites?: any[]; [k: string]: any }
export type Kind = 'spec' | 'doc' | 'folder';
export interface Item {
  id: string; team: string; kind: Kind; title: string; body: string; links: string[]; pinned: boolean; core: boolean; specType: string;
  rev: number; status: 'draft' | 'approved'; version: number; releasedRev: number; releasedAt: string | null; releasedBy?: string | null;
  fetchedAt: string | null; createdAt: string | null; updatedAt: string | null; updatedBy?: string | null; updatedVia?: string | null;
  dirty: boolean; baseRev: number; approve: boolean; revoke: boolean; del: boolean; conflict: any; localSeq: number; editedAt: number | null;
  syncError?: string | null;
}
export interface FormField { key: string; label: string; kind: 'text' | 'longtext' | 'select' | 'list' | 'checklist' | 'requirements' | 'endpoints' | 'diagram' | 'code'; help?: string; tab?: string; options?: string[]; lang?: string }
export interface FormSchema { tabs?: { key: string; label: string }[]; fields: FormField[] }
export interface SpecType { form?: FormSchema | null; view?: 'form' | 'editor'; key: string; label: string; short?: string; description: string; template: string; builtin?: boolean; missing?: boolean; [k: string]: any }
