// Ambient declarations for type-checking the plain-JavaScript server (`npm run typecheck`).
// Nothing here is loaded at run time.

import 'express';

declare global {
  namespace Express {
    // Set by the auth middleware in server/auth.js.
    interface Request {
      user?: any;
      team?: any;
      role?: any;
    }
  }

  // @types/node types `Response.json()` as `Promise<unknown>`; the server reads
  // well-known JSON shapes (OIDC discovery, token responses, Wikipedia) without JSDoc.
  interface Response {
    json(): Promise<any>;
  }
}

declare module 'node:sqlite' {
  // Rows are untyped records; @types/node models each column as the
  // `SQLOutputValue` union, which the server code never narrows.
  interface StatementSync {
    get(...anonymousParameters: any[]): any;
    all(...anonymousParameters: any[]): any[];
  }
}
