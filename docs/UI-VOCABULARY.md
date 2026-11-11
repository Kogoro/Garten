# Words in the interface

One word per idea (the Enterprise-UX guides ask for a strict taxonomy). The interface, the README and the agent instructions use these terms and no others for the same thing. `web/src/vocabulary.test.ts` fails the build when a retired word comes back.

| Idea | Word | Not |
|---|---|---|
| A person confirms a spec or foundation document | **Approve** (button *Approve v2*, state *Approved v1*) | sign off, accept, confirm |
| The approved version reaches the team repository and agents | **Release** / *Released* (page *Release*, button *Release now* for foundation documents) | publish, deploy, go live |
| Send the team repository to its Git remote | **Push** (*Push to Git*) | publish, sync to Git |
| Move changes between device and server | **Sync** | upload, save to server |
| A question an agent asks a person | **Decision** | approval request, ticket |
| An agent's remark on a spec | **Feedback** (kinds: concern, conflict, question, suggestion, gap) | comment, issue |
| What an agent reports about its work | **Report** | status update |
| A re-runnable proof for a claim | **Check** (states: passing, failing, stale, never ran) | test (a test is one kind of check) |
| A rule every agent follows | **Guardrail** | policy, constraint |
| The page where people steer agents | **Garden** | dashboard, inbox |
