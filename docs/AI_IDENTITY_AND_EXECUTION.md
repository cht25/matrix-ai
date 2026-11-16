# The assistant: identity, model transparency and real execution

Two rules shape how QORVYNA AI behaves:

1. It knows what it is, and tells the truth about the model behind it.
2. It never says work was done unless a record shows the work was done.

Both are implemented in code and covered by tests; neither depends on the model
choosing to behave.

---

## 1. Identity

### Who it is

The assistant is **QORVYNA AI** in every mode and every language. Asked who or
what it is, it answers with the brand's sentence, word for word:

> I'm QORVYNA AI, the intelligent assistant of the QORVYNA technology
> ecosystem. I help users build, develop, automate, connect, and manage
> technology through AI, IoT, robotics, cloud services, and software tools.

A Bangla version is returned when the question is asked in Bangla.

That sentence names what the QORVYNA ecosystem is about. What works in this
product today is a separate fact: `BRAND_PILLARS` in `src/lib/brand.ts` marks
each area `live` or `planned`, and **robotics is `planned`** — no robotics
feature exists in the code. The system prompt lists the live areas, names the
planned one, and tells the model to say it is not available yet if asked what
it can do there.

### Which model it runs on

When a user explicitly asks which model, provider or company's technology
powers the assistant, it answers truthfully and specifically. The facts are not
typed into a prompt by hand; they are built from the routing the gateway
resolved for that request:

- `routingFromTargets(pool.targets)` describes the model the request is really
  sent to (and the other models in the user's pool, if any).
- With the default configuration the answer is: *GPT OSS 120B
  (`openai/gpt-oss-120b`), an open-weight model published by OpenAI, served by
  Groq.*
- A deployment that serves the model from its own endpoint is described as
  such ("a dedicated OpenAI-compatible endpoint configured by this
  deployment's operator"), not as Groq.
- It says plainly that QORVYNA did not create the underlying model, and that it
  has no verified facts about training data, parameter counts or cut-off dates.

Without being asked, it does not bring the underlying model up, and it never
introduces itself by the model's or a vendor's name.

### How it is enforced

| Piece | Where |
|---|---|
| Identity sentence, model facts, question detection, direct answers | `src/lib/ai/identity.ts` |
| Identity + model-transparency block appended to **every** system prompt (chat, mode overlays, study, Agent, build pipeline, compare, orchestrate) | `src/lib/ai/prompts.ts`, `src/lib/ai/modes.ts`, `src/lib/server/build.ts`, `src/app/api/ai/compare/route.ts` |
| Standalone identity questions answered by the gateway itself, with no model call | `src/app/api/ai/route.ts` |

The gateway recognises five kinds of standalone question — who are you, which
model, who made you, what happened to the old name, are you some other
assistant — in English and Bangla, and answers from the identity record. The
stored message is tagged `source: "identity"` and carries no model name,
because no model produced it. The shortcut is skipped when the turn is a
regeneration, has attachments or task context, or when the user has set up a
role-play (then "what's your name?" belongs to the story; the system prompt
still carries the identity, so a sincere question gets the real answer).

---

## 2. Doing versus describing

### The problem this solves

A chat model asked to "update my project" can produce a fluent reply that says
the project was updated. Nothing was. QORVYNA closes that gap structurally.

### Two kinds of mode

| | Modes | Can change a project? |
|---|---|---|
| Conversation | General chat, Study, and the other chat styles | No. They answer in words. |
| Execution | **Agent**, Code | Yes, through the build pipeline. |

Only the build pipeline (`POST /api/build`, `src/lib/server/build.ts`) writes
project files, validates, builds and publishes. `/api/ai` never does.

### What happens to a request for real work

`detectBuildIntent` (`src/lib/ai/build-intent.ts`) classifies each message:
build, change, fix, publish, preview — or none. It is deterministic, understands
Bangla and Banglish, and is deliberately conservative: questions ("how do I
deploy it?"), explanations, refusals ("don't deploy yet") and writing tasks
("write a blog post about my website") are not work on a project.

| Where it is asked | What happens |
|---|---|
| **Agent mode** | The request runs. The pipeline plans, writes files, validates, builds and — if asked — publishes, streaming its real stages. |
| **A conversation mode** | Nothing is sent to the model. A card appears: **Awaiting approval** — *Run with Agent* / *Build with Agent* / *Publish with Agent*, or *Answer in chat instead*. One tap either runs it for real or gets a plain answer. |
| `/api/ai` called in Agent mode with executable work | The gateway refuses to answer in prose: `409 AGENT_RUNTIME_REQUIRED`. The browser then starts the pipeline with the same request instead of showing an error. |

These requests all run in Agent mode and all raise the approval card in chat:
"Update my project", "Change the design", "Add this feature", "Remove this
component", "Modify the backend", "Improve the application", "Rebrand the
platform", "Deploy it".

"Deploy it" with no project in the conversation still raises the card. Once
approved, the run cannot resolve a project, so it ends **Blocked** and lists
your projects; choosing one runs the waiting request.

Choosing *Answer in chat instead* sends the message to the model with a system
note that this turn changes, builds and publishes nothing, so the answer is
advice or code and says so.

### Every task ends in a stated outcome

`src/lib/ai/task-outcome.ts` derives the outcome from the stored run — never
from the model's description of what it did.

| Outcome | Meaning |
|---|---|
| **Completed** | The run succeeded. "Published" is said only when the record carries a live address returned by the host. |
| **Failed** | Something broke and the same request may work if retried. *Retry* is offered. |
| **Blocked** | It cannot run until something else changes: no model configured, hosting not configured, no project chosen, signed out, and so on. The obstacle and the next step are named. *Retry* is not offered, because it would hit the same wall. |
| **Awaiting approval** | Parked for the user's go-ahead (the card above). |

While a task is open it can also be *Needs your answer*, *Paused*, *Stopped* or
*Working*.

In the conversation a finished run is shown once, in three parts that do not
repeat each other: the reply (what happened and what to do next), the run card
(state, link or reason, *Retry* / *Deployment details*), and one line with the
state word and the facts — files changed, build step, validation, error code.

### A net for false claims

If a chat reply nevertheless claims project work ("I've updated your project
and deployed it") and no run exists behind it, `unbackedActionClaim` detects it
and the interface labels the reply:

> **Text only.** This reply did not change, build or publish anything — no
> project files were touched. — *Run with Agent*

The system prompt also carries a "Doing versus describing" section telling the
model not to make such claims in the first place.

---

## Trying it without a backend

`/dev-preview/chat` (development only; unavailable in production) runs the real chat
interface against a mock gateway. Its scenario buttons include the identity
questions, the approval card, and runs that end completed, failed and blocked.
The mock builds those runs with the real stage transitions from
`src/lib/deploy/stages.ts` and answers identity questions with the real
identity module, so the wording and states on screen are the product's own.

## Tests

| Suite | Covers |
|---|---|
| `tests/ai-identity.test.ts` | Identity sentence, model facts from routing, every system prompt carrying the identity block, the gateway answering identity questions without a model call, role-play exemption, Bangla |
| `tests/execution-routing.test.ts` | Intent detection for the example requests in English and Bangla, the approval hand-off, `409` rerouting, outcome resolution and blocker table, the outcome line, the "Text only" label |
| `tests/build-intent.test.ts`, `tests/execution-modes.test.ts`, `tests/agent-clarification.test.ts` | Earlier guarantees these build on: chat never executes on its own, `/api/ai` never writes project files, clarification-first requests |

## What was not exercised here

These were verified against a simulated model provider and a Firestore stub.
No provider key or Firebase project was available in the environment where the
change was made, so live model replies, real project builds and real
publishing were not run end to end.
