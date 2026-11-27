# Words in the interface

One word per idea (the Enterprise-UX guides ask for a strict taxonomy). The interface, the README and the agent instructions use these terms and no others for the same thing. `web/tests/vocabulary.test.mjs` fails the build when a retired word comes back.

Everything a team writes grows through three stages, shown as one growth icon: **Seed**, **Sprout**, **Bloom**.

| Idea                                                        | Word                                                                                    | Not                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| A private draft                                             | **Seed** (_Plant a spec_ on Today, _New spec_ in Specs)                                 | draft (in visible text)                  |
| A spec or document that waits for an approver               | **Sprout** (_Ask for approval_, _Waiting for approval_)                                 | pending, to approve                      |
| A person confirms a spec or foundation document             | **Let it bloom** (button _Let it bloom_, _Let v2 bloom_)                                | approve (as a button), sign off, accept  |
| The approved version reaches the team repository and agents | **Bloom** / _In bloom_ (state _Bloom v1_, version history _v1 · Bloomed_)               | released, publish, deploy, go live       |
| An approved spec that was edited since                      | **Sprout** with its version (_Sprout · edited since v2_)                                | approved · edited                        |
| The role that may let things bloom                          | **approver**                                                                            |                                          |
| Send the team repository to its Git remote                  | **Push** (_Push to Git_)                                                                | publish, sync to Git                     |
| Move changes between device and server                      | **Sync**                                                                                | upload, save to server                   |
| The page where people act on what needs them                | **Today**                                                                               | Garden, dashboard, inbox                 |
| A question an agent asks a person                           | **Decision**                                                                            | approval request, ticket                 |
| An agent's remark on a spec                                 | **Feedback** (kinds: concern, conflict, question, suggestion, gap)                      | comment, issue                           |
| What an agent reports about its work                        | **Report**                                                                              | status update                            |
| A re-runnable proof for a claim                             | **Check** (states: passing, failing, stale, never ran)                                  | test (a test is one kind of check)       |
| A person confirms what an agent reported as built           | **Accept** (state _Accepted v2_, card _… is built – take a look_, section _Review_)     | approve, sign off, done                  |
| A person returns a build to the agents with a note          | **Send back** (state _Sent back_)                                                       | reject, reopen                           |
| What a spec should change once it is in use                 | **Outcome** (`## OUTCOMES`, O1 …; states _On target_, _Off target_, _Not measured yet_) | KPI, goal (as a section name), impact    |
| A person has looked at an outcome that is off target        | **Seen**                                                                                | dismiss, acknowledge                     |
| A rule every agent follows                                  | **Guardrail** (kinds _Always_, _Never_)                                                 | policy, constraint                       |
| A term in the glossary                                      | **Word** (_Add a word_, _Make it a word_)                                               | entry                                    |
| What agents know besides specs                              | **Documents**, **Guardrails**, **Glossary** (one tab each; vision and strategy on top)  | context (as a page name), knowledge base |
| The team above / below in the tree                          | **Parent team** / **Child team**                                                        | org, sub-team, workspace                 |
| Foundation a team receives from its parent teams            | **Inherited** (_Inherited from Acme_, _From Acme_ in Guardrails and Glossary)           | merged, global                           |
| A team makes released items visible to other teams          | **Share** (_Share with teams…_)                                                         | publish, expose                          |
| An item of another team as the receiving team sees it       | **From** + team (_From Payments API_, chip with the team key)                           | external, imported                       |
| A spec builds (part of) a spec of another team              | **Implements** (_Implemented by_ at the owner)                                          | child of, realises, epic                 |
| A newer version of a linked or inherited item               | **Update available: v5** (_Update link_, _Accept v5_)                                   | outdated, stale                          |
| A team takes a shared item as its own editable copy         | **Adopt** (_Adopt as own copy_)                                                         | fork, clone, import                      |
