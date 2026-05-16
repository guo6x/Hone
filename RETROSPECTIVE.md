# Retrospective: Architecture Gaps & Process Improvements

## What was missed

### 1. Mobile client was a placeholder, not a product
`relay/client.html` existed with basic WebSocket wiring, but it was never treated as a real deliverable. It had no PWA manifest, no install flow, a mismatched blue theme, and no UX polish. The architecture diagram in `HONE_EVOLUTION.md` mentions "手机消息" as a trigger source but never specified how the user actually sends those messages.

**Root cause**: The three-layer agent architecture (Gateway → CLI → Sub-agents) was designed from the server/desktop perspective. Mobile was an afterthought tagged onto the relay layer without a dedicated design doc or acceptance criteria.

### 2. Relay auth was half-done
Gateway auth (`AUTH_TOKEN`) was implemented, but client auth had no rate limiting, no max-connections guard, no pairing code validation, and no timeout for stuck unapproved clients. A single malicious WebSocket client could brute-force pairing codes or exhaust DO memory.

**Root cause**: The relay was built as infrastructure plumbing. Security hardening was deferred as "later work" without tracking.

### 3. Device pairing was simulated in desktop
`DevicePairingModal.tsx` used `Math.random()` with a fake delay instead of real Tauri IPC to discover and connect to gateways. The desktop UI looked complete but pressing "Connect" was a coin flip.

**Root cause**: The desktop was built UI-first (React components + state) without wiring up the Tauri backend commands. UI development outpaced backend integration.

### 4. End-to-end flow never tested
The full chain (Mobile PWA → Relay → Gateway → CLI → back) was never exercised end-to-end. Each component was tested in isolation or with mocks.

**Root cause**: No integration test plan existed. The project had 4 independent components (Desktop, Relay, Gateway, CLI) being built in parallel by Claude without a human QA gate.

## Why these gaps existed

| Factor | Impact |
|--------|--------|
| **UI-first development** | Desktop screens looked complete but were disconnected from real backend. Creates false sense of progress. |
| **No integration test plan** | Each piece worked alone; nobody checked if they worked together. |
| **Deferred security** | Auth was "started" but never completed. No task was created to track it. |
| **Architecture doc over-specified the happy path** | Gateway→CLI→Sub-agent was detailed; client onboarding and auth were glossed over. |
| **Solo AI development** | No human reviewer caught the `Math.random()` in pairing or the missing mobile PWA. |

## How to prevent going forward

### 1. Always define the "thin slice" first
Before building any component, define one end-to-end user journey that touches every layer, and make that work first. For Hone, that slice would be: "User opens mobile PWA → enters pairing code → Gateway approves → User sends a message → Gateway responds." Nothing else gets built until this works end-to-end.

### 2. No UI without backend wiring
Every UI component that triggers an action must be connected to its real backend before it's marked "done." No `Math.random()`, no `setTimeout` fakes. If the backend isn't ready, leave the button disabled with a clear reason.

### 3. Security in the first pass, not a follow-up
Auth, rate limiting, and input validation go in before the feature is considered complete. Create a 3-item security checklist for every new endpoint/handler:
- [ ] Input validation
- [ ] Auth/authz (if applicable)
- [ ] Rate/resource limits

### 4. Create a living TODO that tracks missing integrations
Whenever a stub, mock, or `TODO` is committed, it must reference an open task. The `DevicePairingModal` `Math.random()` should have had a comment like `// TODO(#XX): Replace with Tauri IPC invoke('scan_lan')`.

### 5. Human review at integration boundaries
If no human is reviewing code, Claude should explicitly list "what's real vs what's simulated" at the end of each session. A 3-line summary of stubs/mocks would have caught all of these gaps in 10 seconds.
