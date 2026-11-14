// What the editor's term chips show on hover: the page that hosts an editor registers a lookup over the team's glossary.
export interface TermInfo { term: string; folder: string; text: string; aliases: string[]; avoid: string[]; version?: number }
let lookup: (name: string) => TermInfo | null = () => null;
export const setTermLookup = (fn: (name: string) => TermInfo | null) => { lookup = fn; };
export const lookupTerm = (name: string) => lookup(name);
