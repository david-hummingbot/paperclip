# Coordination rooms

A coordination room is a company-scoped effort with a member list, for
cross-repo work that needs two or three agents at once.

Standing work stays one agent per repo: a hummingbot-api pull request wakes the
hummingbot-api agent alone, on its own session and its own primary checkout. A
room does not replace that. It exists for the effort that spans repos — testing
a change across hummingbot-api and condor — where the agents that own those
repos need a shared thread and a shared checkout.

## Why it is not a chat channel

The transcript is an **issue**, so comments, activity, budgets and the existing
thread UI all keep working with no parallel machinery. `chat_endpoints`
deliberately binds one endpoint to one agent; a room needs many agents, so
membership is a join table rather than a single conversation id.

Conference Room is a different thing: one company concierge, gated to
`local_trusted` single-operator instances. Slack and the other external
channels can bridge into a room later; today the board is where you open a
room, pick the agents, and read the thread.

## Session isolation is free

The session key is `(companyId, agentId, adapterType, taskKey)`, and
`deriveTaskKey` falls back to `contextSnapshot.issueId`. Because the room's
transcript is an issue and the wake context names it, each member automatically
gets a session scoped to that room.

So the condor agent can be reviewing a condor pull request, working in the api
room, and working in the hummingbot room, with three distinct cwds and three
distinct sessions — and none of them resume each other. There is no room
session table, and adding one would be a mistake.

## Runs serialize; trees do not

`issues.executionRunId` is stamped per issue under `SELECT … FOR UPDATE`, and a
room has one transcript issue. **Two members cannot execute on it at the same
time.** A fan-out wake queues and runs in order, and the existing coalesce and
defer behaviour absorbs duplicates.

This is a decision, not an oversight. The alternatives were a per-member
execution claim keyed `(issueId, agentId)`, or one transcript issue plus N
shadow issues. Serializing preserves the atomic-checkout invariant
(`AGENTS.md` §5.3) and needs no lock change; the other two stay available if
serialization ever becomes the measured bottleneck.

Serialization applies to **runs only**. Every member's worktree exists
concurrently and may hold uncommitted work while another member's run holds the
lock.

## Wake rules

`POST /api/companies/:companyId/rooms/:roomId/messages` posts a message into the
transcript and wakes the members it names.
`POST /api/companies/:companyId/rooms/:roomId/wake-plan` resolves the same
fan-out **without** posting, because the fan-out is the easy thing to get wrong
and the board should be able to show it before sending.

- **No mention** → every member is queued. `broadcast: true`.
- **Mentions** → only the named members. A mentioned non-member is ignored
  rather than silently joining the room.
- A **closed** room refuses wakes; a room with no transcript issue refuses too.
- An agent's own message never wakes that agent.

Mentions come from the message body, parsed exactly as any issue comment's are
(`agent://<id>` links), unioned with any ids the caller passes in
`mentionAgentIds`. The board composer already writes those links, so it needs
neither field.

Members are enqueued **one at a time, in membership order**, so the serialized
queue is deterministic rather than whatever order a parallel dispatch resolved
in. A member whose wake is refused — a spent budget, a paused agent — is logged
and skipped; the message is already posted and the other members still need it.
The response reports `wokeAgentIds`, which is the plan minus those skips.

### A room wake is a mention wake

The wake carries `wakeReason: "issue_comment_mentioned"` and
`source: "comment.mention"`. That is not cosmetic, and renaming it to something
room-specific breaks rooms in a way that only shows up in production, as runs
that queue and are then cancelled.

The transcript issue is unassigned, so every member is a non-owner, and three
separate mechanisms key off exactly this reason to allow that:

| Mechanism | Without the mention reason |
| --- | --- |
| `decideIssueOwnership` (`modules/run-dispatch/domain/policy.ts`) | The queued run is cancelled as `issue_assignee_changed`. It grants ownership to a non-assignee only for an *interaction wake*, which `allowsIssueInteractionWake` defines as a reason in `ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS` **plus** a resolvable comment id. |
| The deferred-wake drain (`modules/wake-queue/application/use-cases.ts`) | A member queued behind another member's run has its wake cancelled as "belonging to the current assignee". `issue_comment_mentioned` is deliberately excluded from that rule so a mention survives. |
| `shouldAutoCheckoutIssueForWake` | Members would try to auto-check-out the transcript, fighting over one issue's assignment. This reason explicitly refuses auto-checkout. |

A room therefore needs no new wake policy. It needs a second way to decide who
was named — that is the membership list — and everything after it is the
existing mention path. `coordinationRoomId` rides along on the context snapshot
so a run can tell which room woke it; nothing reads it to decide anything.

## Assignment and budgets

The transcript issue stays **unassigned**. Members are woken through the
membership table, never by assignment, so no issue ever carries two assignees
and the single-assignee task model is untouched. An agent that needs an owned
task creates a normal issue from the room.

Budgets fan out. The budget gate is per agent at claim time, so one un-mentioned
message in an N-member room produces N claims against N budgets on one issue.
Each member's own cap applies as usual; a room does not add a second cap.

## Room workspace

A room can hold a shared integration checkout, separate from every member's
everyday checkout, with `workspaceRootPath` on the room and a `worktreePath`
and `branchName` per member.

Each member works in their own tree: the condor agent's tree is not the
hummingbot-api agent's tree. A room wake sets that agent's cwd to their
worktree. The agent's computer does not change — a Docker or SSH agent runs the
tree on that computer, a `shared` agent on the Paperclip host. **A room never
allocates a second machine.**

Closing a room stops wakes and leaves every primary checkout in place. Unmerged
member branches stay until they are deleted.

## API

| Method | Path |
| --- | --- |
| `GET` | `/api/companies/:companyId/rooms` |
| `GET` | `/api/companies/:companyId/rooms/:roomId` |
| `POST` | `/api/companies/:companyId/rooms` |
| `PATCH` | `/api/companies/:companyId/rooms/:roomId` |
| `POST` | `/api/companies/:companyId/rooms/:roomId/members` |
| `DELETE` | `/api/companies/:companyId/rooms/:roomId/members/:agentId` |
| `POST` | `/api/companies/:companyId/rooms/:roomId/wake-plan` |
| `POST` | `/api/companies/:companyId/rooms/:roomId/messages` |

Creating a room with `seedMembersFromRepos` (the default) pre-fills members by
matching each agent's `primaryRepoFullName` against the room's `repoFullNames`.
Explicit `agentIds` are added on top, and members can be added or removed by
hand afterwards.

Creating a room also opens its transcript issue, through the issue service, so
it has a real identifier, activity and sequence like any other issue — that
identifier is what the thread UI and the session `taskKey` use. Pass
`createTranscriptIssue: false` when an existing unassigned issue is the thread,
then attach it with the transcript endpoint.

## Not yet implemented

- The room workspace checkout and per-member worktree creation (item 9). The
  columns exist and are settable; nothing creates the trees yet, so a room wake
  currently runs on the member's ordinary cwd.
- The board UI for opening a room and reading the thread.
