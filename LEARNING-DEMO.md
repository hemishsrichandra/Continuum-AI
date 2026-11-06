# Continuum learning demonstration

The current workflow is documented in [IMPLEMENTATION.md](IMPLEMENTATION.md). It requires customer confirmation before knowledge publication.

1. Start the app in WSL using `bash scripts/start-wsl.sh`.
2. At `/desk`, create a company owner account. Open **Company & team**.
3. Generate a customer signup link and use it to create customers A and B with distinct emails. Use separate browser profiles or sign out between accounts.
4. Invite a specialist, or use the owner's specialist console. Invitations are restricted to their intended email and expire after 48 hours.
5. A creates a request and asks for a specialist. B creates a similar request with product/version details.
6. Ask B a troubleshooting question before specialist work: no company resolution exists yet.
7. The specialist claims A's case, records troubleshooting and a progress update, and proposes reviewed steps with matching symptoms and applicability.
8. Ask B again before A confirms: the pending fix must not be reused.
9. A reviews the specialist message and selects **Yes, the issue is fixed**. Only now is knowledge published. Check the specialist library for `synced`.
10. Ask B varied, previously unseen paraphrases. Inspect **Sources & response details** for Hindsight, the model, and a verified resolution. Wrong product/version questions must exclude the fix; missing prerequisites must ask for clarification.
11. Switch memory OFF in B's existing conversation: the model must not receive previous learned answers as context.
12. Retire the resolution and ask B again. The old conversation remains visible, but the retired steps must not enter the new answer through recall or assistant history.

Run `npm run verify:live` for an isolated synthetic evaluation with separate Hindsight namespaces. It reports publication gating, five held-out paraphrases, incompatible/unrelated questions, OFF, company isolation, and retirement. Reports are saved under ignored `data/`.

Local mode is useful for deterministic regressions, but a `local` or `pending` status does not establish working cloud integration. Email and Google Calendar are optional for this demonstration.

This demonstrates retrieval and reuse of reviewed outcomes; it does not retrain model weights. Broader domains, languages, products, and failure cases need their own held-out evaluations before launch.
