# Company and customer interface separation

Implemented November 7, 2026 at the product owner's request.

- Owners open Company & team, with Customer cases, member/invitation and business-connection management.
- Owners' case console shows Standard cases / IT cases, assignment, progress, troubleshooting, solutions and resolution review.
- Specialists open their authorized console and retain case-management permissions.
- Neither role has My requests, personal request creation, personal note/visit/outcome controls, customer chat or customer acceptance/reuse-feedback controls. `/desk?view=personal` and calendar query parameters cannot bypass the redirect.
- Both company pages now have Account & security and Sign out directly. Identity, email verification, sessions, sign out all devices and password change remain accessible. Personal-visit calendar and delivery panels are omitted from this staff dialog.
- Customer accounts retain their request, chat, notes, booking, outcome and confirmation workflows.

The API returns 403 for owner/staff customer-workflow routes, including direct request/note/booking/handoff/outcome/chat/memory/confirmation calls and personal workspace reads. Company/operator and account/security endpoints remain authorized by their existing company/category/assignment checks. Customer confirmation remains separate from staff proposal and progress updates.

Existing owner/staff personal test records are preserved in storage; no deletion, transfer or fabricated customer confirmation occurred. They are no longer available as a personal customer workspace. A separate customer account is required for customer journeys and future testing. Existing specialist cases remain visible in the appropriate company console.

This change does not automatically send every new customer request to the specialist queue. The queue still contains confirmed specialist handoffs. Changing that intake behavior is separate from this role separation.

Validation: 71/71 automated tests and HTTP checks passed. A new permission test exercises owner and actual specialist identities across customer endpoints and checks no business side effects, while retaining operator/account/customer access. Authentication/calendar/isolation fixtures now use real customer identities where those workflows require one. The live verification script's other-company fixture was similarly corrected; paid semantic evaluations were not redundantly repeated for this authorization/navigation change.

Browser checks used isolated owner, staff and customer accounts: owner personal URL redirected to Company & team; owner case view contained no personal links/create/visit actions; specialist personal/calendar URL redirected to its console; both staff account dialogs and logout worked; customer request creation remained available. Evidence: ignored output/manual-tests/company-cases-interface.png.

Earlier manuals and test reports describe the previous combined-role behavior. This document supersedes their owner/staff personal-workspace instructions; historical test evidence remains dated history.
