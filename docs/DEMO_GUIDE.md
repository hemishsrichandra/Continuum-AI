# Interactive Learning Demo — judge guide

**Fictional demonstration.** Continuum retrieves and reuses approved knowledge; it does **not** train or change model weights. The demo at **`/demo`** is completely separate from the real application: it reads and writes none of a company's tickets, databases, embeddings, memory pool, Hindsight, connectors or analytics, needs no credentials or network, and every browser tab gets its own private, temporary, resettable session.

## Run it
```bash
npm ci
npm start            # then open http://localhost:3100/demo   (or: npm run demo:learning -- --serve)
```
Headless proof of the same chain, no server: `npm run demo:learning`.

## 2–4 minute script
1. **Open `/demo`.** Point at the counter: **Learned memory 0**. The only starting suggestions are two hardcoded playbooks (shown labelled *Initial standard suggestion*).
2. **User A** → *Use script text* → *Report issue*. A sees the hardcoded “restart the laptop” idea. Counter still 0.
3. A clicks **Still need help**. The case appears in the **demo-only** specialist queue (never a real company's).
4. **Company** panel → *Use scripted solution* → *Preview passport* (scrubbed text, `C_init`) → *Send to User A*. Nothing is learned yet (still 0).
5. Back in User A: **It worked**. Only now the counter goes **0 → 1** and the timeline shows *Verified demo memory created*.
6. **User B** → *Use script text* (same problem, different words) → *Report issue*. B receives **“Learned from User A’s confirmed specialist resolution”** with the steps and a *Why this was recommended* explanation (similarity, compatibility, reliability, `S_final ≥ 0.70`). Click **It worked**.
7. The banner reads **User A taught Continuum → verified demo memory created → User B benefited**, with a before/after comparison.
8. Click **Reset demo**: memory returns to 0 and User B can no longer receive A's fix. *Try an incompatible device* shows a different device/version does **not** get the learned fix.

Prefer a hands-off tour? **Run guided scenario** performs steps 2–7 through the same public actions, with a visible step indicator.

## What is real and what is simulated
* Real: the state transitions, the scoring formulas (`C_init`, cosine + BM25 hybrid, compatibility gate, reliability), PII scrubbing, safety screening, isolation, reset, expiry (60 min idle).
* Simulated: the customers, the specialist and the laptop issue. The “fix” is fictional (*“Fictional demo only: …”*, and that qualifier is preserved).
* Retrieval inside the demo uses a local offline concept embedding plus in-memory BM25 over **this session's** learned fixes only.

## Isolation guarantees (and the tests that check them)
`test/demo-isolation.test.js`: imports only pure helpers; empty start; before A confirms B gets no learned fix; after, a compatible B does and an incompatible/unknown-device/unrelated B does not; two sessions never see each other; reset clears; idle sessions expire; the main database (every table) is byte-for-byte unchanged and no network/model/Hindsight/connector call happens even when the demo is called with production-looking payloads.
