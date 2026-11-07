# Continuum learning demonstration

Run `npm run demo:multi` in WSL with the repository's Node 22 runtime. It uses a new temporary SQLite database, fictional accounts and local providers, asserts the complete sequence and removes its database when finished. Run `npm run demo:multi -- --serve` to inspect the resulting state at `http://localhost:3211/desk`; the script prints fictional credentials and disables all live integrations. Add `--keep` to preserve only this generated demo database.

The script demonstrates:

1. Company A has two customers and separate repair and IT chatbots.
2. Customer One reports a Model X network issue and fails the configured standard connection check.
3. With no learned fix yet, the issue enters A's human queue. A specialist claims it, proposes structured reviewed steps, and Customer One confirms success.
4. Customer Two reports a compatible issue, fails the standard stage, receives the confirmed learned fix and records success.
5. A separate issue demonstrates learned reuse failure, one human case, and knowledge review.
6. A's IT chatbot and Company B cannot retrieve A's repair solution, even after its review is cleared.
7. Customer One joins and switches between two companies using one account.

For manual testing from an empty isolated database, create the company, two customers and individual staff accounts through signup links and invitations. Configure the standard playbook in **Company & team → Support services**. Finish Customer One's publication lifecycle before Customer Two fails the standard stage; otherwise Customer Two correctly enters human support because no suitable published fix exists yet. A direct Human help request prepares a handoff for explicit confirmation. An exhausted troubleshooting flow submits its local case automatically and reports success only after the commit.

The specialist console shows standard and learned attempt snapshots, outcomes, conversations, assignment and revision checks. Customers confirm or reject proposals in their own service workspace. Memory off preserves operational cases/attempts but disables optional AI memory; a specialist solution confirmed with memory off remains private.

See [MULTI-COMPANY.md](MULTI-COMPANY.md) for the data model, migration, service configuration, gateway contract, memory scopes and limits, and [MULTI-COMPANY-VERIFICATION.md](MULTI-COMPANY-VERIFICATION.md) for actual verification results. The retained `verify:live` script uses live credentials and remote services; it was not run during this implementation.

This is retrieval and reuse of reviewed resolutions, not model-weight training.
