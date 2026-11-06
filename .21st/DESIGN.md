# Continuum

Use the tokens in design.json, Manrope headings, and DM Sans/system body text. Preserve the clear blue/charcoal identity. Use --on-accent for text on brand blue and --text-secondary for secondary labels; these combinations were checked with axe. Keep buttons at least 32px on desktop and 44px on mobile, visible focus, semantic labels, and a dedicated response announcement region.

Marketing pages live in web/pages.js, authenticated desk flows in web/ui.js, account forms in web/auth-ui.js, and shared request/CSRF/calendar helpers in web/client.js. The browser uses HttpOnly cookies rather than stored bearer credentials. New accounts start with an empty workspace and a clear first action.

Keep missing integration configuration visible and explain how to enable it. Never label an email sent or a calendar connected before the provider acknowledges it. No invented customer, funding, certification, or guarantee claims.

The 21st CLI review runs and reports informational hardcoded-color notices. Automated WCAG checks are run separately using the explicitly enabled dev-only axe scanner; production never serves that scanner.
